import os from "node:os";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import type { Bus } from "../core/bus.js";
import type { ChatService } from "../core/chat.js";
import type { Config } from "../core/config/config.js";
import { saveConfig } from "../core/config/config.js";
import { sessionToMarkdown } from "../core/session/export.js";
import type { ChatStatus } from "../core/types.js";
import type { OllamaRuntime, ParallelStatus } from "../core/ollama-runtime.js";
import { padEndWidth, truncateWidth } from "../util/ansi.js";
import { errorMessage } from "../util/errors.js";
import { readJson, writeJsonAtomic } from "../util/fs.js";
import { historyFile, shortPath } from "../util/paths.js";
import type { ToolApprovalRequest } from "../tools/types.js";
import { sanitizeText, singleLine } from "../util/text.js";
import { formatBytes, relativeTime } from "../util/time.js";
import { version } from "../version.js";
import { renderApproval } from "./dialog.js";
import { Editor, wrapChars } from "./editor.js";
import type { Key } from "./keys.js";
import { KeyParser } from "./keys.js";
import { buildLogo, logoWidth } from "./logo.js";
import { Picker, renderPicker, type PickerItem } from "./picker.js";
import { Screen } from "./screen.js";
import { Terminal } from "./terminal.js";
import { getPalette, type Palette } from "./theme.js";
import { shortTitle, Transcript } from "./transcript.js";
import type { Line } from "./types.js";
import { fitLine, lineWidth, padLine, spaces } from "./types.js";

export interface TuiOptions {
  chat: ChatService;
  bus: Bus;
  config: Config;
  /** Disk config (no env overrides) used when persisting preferences. */
  persistedConfig: Config;
  configPath: string;
  cwd: string;
  promptSource?: string;
  compactionPromptSource?: string;
  onModelChange?: (model: string) => Promise<void> | void;
  runtime?: OllamaRuntime;
}

type PickerKind = "model" | "session" | "thinking" | "context" | "parallel";

const COMMANDS: Array<{ name: string; description: string }> = [
  { name: "help", description: "show commands and keys" },
  { name: "model", description: "select or set a model" },
  { name: "new", description: "start a new session" },
  { name: "sessions", description: "switch session" },
  { name: "retry", description: "regenerate the last answer" },
  { name: "compact", description: "compress older session turns" },
  { name: "memory", description: "show compacted session memory" },
  { name: "tools", description: "show available agent tools" },
  { name: "reasoning", description: "toggle thinking output" },
  { name: "think", description: "choose the model's thinking mode" },
  { name: "context", description: "set Ollama's context window" },
  { name: "parallel", description: "check/set local Ollama parallel" },
  { name: "clear", description: "clear the screen" },
  { name: "export", description: "save the session as Markdown" },
  { name: "info", description: "show session details" },
  { name: "quit", description: "exit tinycode" },
];

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * The terminal UI. It only reads ChatService state and calls its public API;
 * all core events arrive through the bus. This keeps the agent logic reusable
 * by a future HTTP server, desktop shell or web UI.
 */
export class TinyCodeTui {
  private readonly terminal = new Terminal();
  private readonly screen: Screen;
  private readonly palette: Palette;
  private readonly transcript: Transcript;
  private readonly editor = new Editor();
  private readonly parser: KeyParser;
  private readonly unsubs: Array<() => void> = [];

  private picker: Picker | null = null;
  private pickerKind: PickerKind | null = null;
  private pickerHits: Array<{ row: number; left: number; right: number; index: number }> = [];
  private modelSetup = false;
  private parallel: ParallelStatus | null = null;
  private sessionId: string | null = null;
  private approval: { request: ToolApprovalRequest; finish: (allow: boolean) => void } | null = null;
  private approveAll = false;

  private scroll = 0;
  private viewportHeight = 1;
  private lastTotalLines = 0;

  private spinner = 0;
  private spinnerTimer: ReturnType<typeof setInterval> | null = null;
  private loadingText: string | null = null;

  private completionInput = "";
  private completionIndex = 0;

  private renderQueued = false;
  private exiting = false;
  private resolveExit: (() => void) | null = null;
  private signalHandler: (() => void) | null = null;

  constructor(private readonly options: TuiOptions) {
    this.palette = getPalette(options.config.ui.theme);
    this.transcript = new Transcript(this.palette);
    this.transcript.showReasoning = options.config.ui.showReasoning;
    this.transcript.showToolOutput = options.config.ui.showToolOutput;
    this.screen = new Screen((chunk) => this.terminal.write(chunk));
    this.parser = new KeyParser((key) => this.onKey(key));
  }

  async run(): Promise<void> {
    this.terminal.start(this.options.config.ui.mouse);
    try {
      await this.loadHistory();
      this.attach();
      this.options.chat.setApprovalHandler((request) => this.requestApproval(request));
      this.terminal.onData((chunk) => this.parser.push(chunk));
      this.terminal.onResize(() => {
        this.screen.resize(this.terminal.width, this.terminal.height);
        this.scheduleRender();
      });
      this.signalHandler = () => this.shutdown();
      process.once("SIGTERM", this.signalHandler);
      process.once("SIGHUP", this.signalHandler);

      this.render();
      void this.checkParallel().catch((error) => {
        this.transcript.notice(`Parallel check: ${errorMessage(error)}`, "warn");
        this.scheduleRender();
      });
      await new Promise<void>((resolve) => {
        this.resolveExit = resolve;
      });
    } finally {
      await this.saveHistory();
      this.cleanup();
    }
  }

  private attach(): void {
    const { bus } = this.options;
    this.unsubs.push(
      bus.on("message.started", () => this.scheduleRender()),
      bus.on("message.delta", () => this.scheduleRender()),
      bus.on("message.updated", () => this.scheduleRender()),
      bus.on("message.ended", () => this.scheduleRender()),
      bus.on("session.changed", () => this.scheduleRender()),
      bus.on("status", (status) => {
        this.updateSpinner(status);
        this.scheduleRender();
      }),
      bus.on("notice", ({ text, level }) => {
        this.transcript.notice(text, level);
        this.scheduleRender();
      }),
    );
  }

  private updateSpinner(status: ChatStatus): void {
    const active =
      status.state === "compacting" ||
      status.state === "connecting" ||
      status.state === "thinking" ||
      status.state === "responding" ||
      status.state === "tool";
    if (active && !this.spinnerTimer) {
      this.spinnerTimer = setInterval(() => {
        this.spinner++;
        this.scheduleRender();
      }, 120);
    } else if (!active && this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }
  }

  private get generating(): boolean {
    const state = this.options.chat.status.state;
    return (
      this.options.chat.busy ||
      state === "connecting" ||
      state === "compacting" ||
      state === "thinking" ||
      state === "responding" ||
      state === "tool"
    );
  }

  private scheduleRender(): void {
    if (this.renderQueued || this.exiting) return;
    this.renderQueued = true;
    setTimeout(() => {
      this.renderQueued = false;
      this.render();
    }, 16);
  }

  private render(): void {
    if (this.exiting) return;
    const width = this.terminal.width;
    const height = this.terminal.height;
    this.screen.resize(width, height);

    const session = this.options.chat.current;
    if (session) {
      if (this.sessionId !== session.meta.id) {
        this.sessionId = session.meta.id;
        this.transcript.reset();
        this.transcript.showReasoning = this.options.config.ui.showReasoning;
        this.transcript.showToolOutput = this.options.config.ui.showToolOutput;
        this.scroll = 0;
        this.lastTotalLines = 0;
      }
      this.transcript.sync(session.messages);
    }

    const headerHeight = height >= 16 ? 2 : 1;
    const footerHeight = height >= 10 ? 1 : 0;
    const maxComposerLines = Math.max(1, Math.min(7, height - headerHeight - footerHeight - 3));
    const composer = this.buildComposer(width, maxComposerLines);
    const areaTop = headerHeight;
    const areaHeight = Math.max(1, height - headerHeight - footerHeight - composer.lines.length);
    this.viewportHeight = areaHeight;

    const frame: Line[] = Array.from({ length: height }, () => []);
    frame[0] = this.buildHeader(width);
    if (headerHeight === 2) {
      frame[1] = [{ text: "─".repeat(width), style: { fg: this.palette.border } }];
    }

    let transcriptLines = this.transcript.build(width);
    if (transcriptLines.length === 0 && !this.generating) {
      transcriptLines = this.welcomeLines(width, areaHeight);
    }

    const total = transcriptLines.length;
    if (this.scroll > 0 && this.lastTotalLines > 0 && total > this.lastTotalLines) {
      this.scroll += total - this.lastTotalLines;
    }
    this.lastTotalLines = total;
    const maxScroll = Math.max(0, total - areaHeight);
    this.scroll = Math.max(0, Math.min(this.scroll, maxScroll));

    const start = Math.max(0, total - areaHeight - this.scroll);
    const visible = transcriptLines.slice(start, start + areaHeight);
    for (let row = 0; row < areaHeight; row++) {
      frame[areaTop + row] = visible[row] ?? [];
    }

    const composerTop = areaTop + areaHeight;
    for (let row = 0; row < composer.lines.length; row++) {
      frame[composerTop + row] = composer.lines[row] ?? [];
    }

    if (footerHeight > 0) frame[height - 1] = this.buildFooter(width);

    let cursor: { row: number; col: number } | null = composer.cursor
      ? { row: composerTop + composer.cursor.row, col: composer.cursor.col }
      : null;

    if (this.approval) {
      const rendered = renderApproval(this.approval.request, width, height, this.palette);
      for (let index = 0; index < rendered.lines.length; index++) {
        const row = rendered.top + index;
        if (row >= 0 && row < height) frame[row] = rendered.lines[index]!;
      }
      cursor = null;
    } else if (this.picker) {
      const rendered = renderPicker(this.picker, width, height, this.palette);
      this.pickerHits = rendered.hits;
      for (let index = 0; index < rendered.lines.length; index++) {
        const row = rendered.top + index;
        if (row >= 0 && row < height) frame[row] = rendered.lines[index]!;
      }
      cursor = null;
    }

    this.screen.render(frame, cursor);
  }

  private buildHeader(width: number): Line {
    const palette = this.palette;
    const left: Line = [
      { text: "◆ ", style: { fg: palette.accent, bold: true } },
      { text: "TinyCode", style: { fg: palette.text, bold: true } },
      { text: ` ${version()}`, style: { fg: palette.faint } },
    ];

    const model = sanitizeText((this.options.chat.currentModel ?? this.options.config.model).split("/").at(-1) ?? "");
    const maxRight = Math.max(10, width - lineWidth(left) - 4);
    const right: Line = [
      { text: "ollama", style: { fg: palette.faint } },
      { text: " · ", style: { fg: palette.faint } },
      { text: truncateWidth(model, Math.max(4, maxRight - 9)), style: { fg: palette.muted } },
    ];

    const session = this.options.chat.current;
    const titleSpace = width - lineWidth(left) - lineWidth(right) - 6;
    const middle: Line =
      session && titleSpace >= 10
        ? [
            { text: "  " },
            { text: shortTitle(session.meta.title, titleSpace), style: { fg: palette.faint } },
          ]
        : [];

    const padding = Math.max(1, width - lineWidth(left) - lineWidth(middle) - lineWidth(right));
    return [...left, ...middle, ...spaces(padding), ...right];
  }

  private centered(line: Line, width: number): Line {
    const pad = Math.max(0, Math.floor((width - lineWidth(line)) / 2));
    return [...spaces(pad), ...line];
  }

  private centerBlock(lines: Line[], width: number): Line[] {
    if (lines.length === 0) return [];
    const max = Math.max(...lines.map((line) => lineWidth(line)));
    const pad = Math.max(0, Math.floor((width - max) / 2));
    return lines.map((line) => [...spaces(pad), ...line]);
  }

  private welcomePanel(width: number): Line[] {
    const palette = this.palette;
    const panelWidth = Math.max(16, Math.min(66, width - 4));
    const inside = panelWidth - 4;
    const model = (this.options.chat.currentModel ?? this.options.config.model).split("/").at(-1) ?? "";
    const fields = [
      ["Model", model, "/model"],
      ["Thinking", this.options.chat.currentThinking, "/think"],
      ["Context", `${this.options.chat.contextLimit.toLocaleString("en-US")} tokens`, "/context"],
      ["Folder", shortPath(this.options.chat.current?.meta.cwd ?? this.options.cwd), ""],
      ["Memory", this.options.config.compaction.auto ? "automatic compaction" : "manual compaction", "/compact"],
    ];
    const rows: Line[] = [[{ text: `╭─ Session setup ${"─".repeat(Math.max(0, panelWidth - 18))}╮`, style: { fg: palette.border } }]];
    for (const [label, value, command] of fields) {
      const hint = width >= 54 ? command! : "";
      const valueWidth = Math.max(1, inside - 10 - hint.length);
      const row: Line = [
        { text: label!.padEnd(9), style: { fg: palette.faint, bg: palette.panel } },
        { text: truncateWidth(sanitizeText(singleLine(value!)), valueWidth), style: { fg: palette.text, bg: palette.panel } },
      ];
      const content = [...padLine(row, inside - hint.length, { bg: palette.panel }),
        { text: hint, style: { fg: palette.accent, bg: palette.panel } }];
      rows.push([{ text: "│ ", style: { fg: palette.border } }, ...content, { text: " │", style: { fg: palette.border } }]);
    }
    rows.push([{ text: `╰${"─".repeat(panelWidth - 2)}╯`, style: { fg: palette.border } }]);
    return this.centerBlock(rows, width);
  }

  private welcomeLines(width: number, height: number): Line[] {
    const palette = this.palette;
    const fullLogo = buildLogo(palette);
    const full = height >= 18 && logoWidth(fullLogo) + 4 <= width;
    const logo = this.centerBlock(full ? fullLogo : buildLogo(palette, true), width);
    let content: Line[] = [
      ...logo,
      [],
      ...(full ? [this.centered([{ text: "Local models. Real code.", style: { fg: palette.faint } }], width), []] : []),
      ...this.welcomePanel(width),
      [],
      this.centered([{ text: "/sessions   /new   /help", style: { fg: palette.accent } }], width),
      this.centered([{ text: "Type a task below and press Enter", style: { fg: palette.faint } }], width),
    ].map((line) => fitLine(line, width));
    if (content.length > height) content = content.slice(0, Math.max(1, height));

    const topPadding = Math.max(0, Math.floor((height - content.length) / 2));
    return [...Array.from({ length: topPadding }, (): Line => []), ...content];
  }

  private buildComposer(
    width: number,
    maxLines: number,
  ): { lines: Line[]; cursor: { row: number; col: number } | null } {
    const palette = this.palette;
    const innerWidth = Math.max(8, width - 6);

    const wrapped = wrapChars(this.editor.value, this.editor.cursor, innerWidth);
    const totalLines = wrapped.lines.length;
    const displayCount = Math.max(1, Math.min(maxLines, totalLines));

    let start = 0;
    if (totalLines > displayCount) {
      start = Math.max(0, Math.min(totalLines - displayCount, wrapped.cursorRow - displayCount + 1));
    }

    const borderStyle = {
      fg: this.generating ? palette.borderActive : palette.border,
    };
    const lines: Line[] = [];
    lines.push([{ text: `╭${"─".repeat(Math.max(0, width - 2))}╮`, style: borderStyle }]);

    for (let index = 0; index < displayCount; index++) {
      const lineIndex = start + index;
      const content = wrapped.lines[lineIndex];
      let body: Line;
      if (this.editor.isEmpty && lineIndex === 0) {
        body = [
          {
            text: padEndWidth(truncateWidth("Ask anything…  /help for commands", innerWidth), innerWidth),
            style: { fg: palette.faint, dim: true },
          },
        ];
      } else {
        body = [{ text: padEndWidth(content ?? "", innerWidth) }];
      }
      lines.push([
        { text: "│ ", style: borderStyle },
        { text: "❯ ", style: { fg: palette.accent, bold: true } },
        ...body,
        { text: " │", style: borderStyle },
      ]);
    }

    lines.push([{ text: `╰${"─".repeat(Math.max(0, width - 2))}╯`, style: borderStyle }]);

    const relativeRow = wrapped.cursorRow - start;
    const cursor =
      relativeRow >= 0 && relativeRow < displayCount
        ? { row: 1 + relativeRow, col: 4 + wrapped.cursorCol }
        : null;

    return { lines, cursor };
  }

  private buildFooter(width: number): Line {
    const usage = this.options.chat.contextUsage;
    const context: Line = [{
      text: width < 34
        ? `${usage.percent}% ${usage.estimated ? "~" : ""}${usage.tokens}/${usage.maxTokens}t`
        : `ctx ${usage.percent}% · ${usage.estimated ? "~" : ""}${usage.tokens.toLocaleString("en-US")}/${usage.maxTokens.toLocaleString("en-US")} tok`,
      style: { fg: usage.percent >= 90 ? this.palette.error : usage.percent >= 70 ? this.palette.warn : this.palette.accent },
    }];
    const status = fitLine(this.statusLine(), Math.max(0, Math.min(24, width - lineWidth(context) - 2)));
    const available = Math.max(0, width - lineWidth(status) - lineWidth(context) - 3);
    const hints = this.footerHints(available);
    const gap = Math.max(1, width - lineWidth(status) - lineWidth(context) - lineWidth(hints) - 1);
    return fitLine([...status, ...spaces(status.length ? 1 : 0), ...context, ...spaces(gap), ...hints], width);
  }

  private statusLine(): Line {
    const palette = this.palette;
    if (this.loadingText) {
      return [
        { text: "  ◐ ", style: { fg: palette.accent } },
        { text: this.loadingText, style: { fg: palette.muted } },
      ];
    }

    const status = this.options.chat.status;
    if (status.state === "compacting") {
      const glyph = SPINNER[this.spinner % SPINNER.length]!;
      return [
        { text: `  ${glyph} `, style: { fg: palette.reasoning } },
        { text: `compacting session${status.detail ? ` · ${status.detail}` : ""}`, style: { fg: palette.muted } },
      ];
    }
    if (status.state === "tool") {
      return [
        { text: "  ⚙ ", style: { fg: palette.accent } },
        { text: status.detail ?? "running tool", style: { fg: palette.muted } },
      ];
    }
    if (status.state === "connecting" || status.state === "thinking" || status.state === "responding") {
      const glyph = SPINNER[this.spinner % SPINNER.length]!;
      const label =
        status.state === "connecting" ? "loading model" : status.state === "thinking" ? "thinking" : "writing";
      const bits = [label];
      return [
        { text: `  ${glyph} `, style: { fg: palette.accent } },
        { text: bits.join(" · "), style: { fg: palette.muted } },
      ];
    }

    if (this.scroll > 0) {
      return [{ text: `  ↑ ${this.scroll} lines`, style: { fg: palette.faint } }];
    }

    const session = this.options.chat.current;
    const bits = [`${session?.meta.messageCount ?? 0} msgs`];
    return [
      { text: "  ● ", style: { fg: palette.success } },
      { text: `ready · ${bits.join(" · ")}`, style: { fg: palette.faint } },
    ];
  }

  private footerHints(maxWidth: number): Line {
    const palette = this.palette;
    if (maxWidth <= 0) return [];
    if (this.approval) {
      return [{ text: truncateWidth(" y allow · n deny ", maxWidth), style: { fg: palette.faint } }];
    }
    if (this.picker) {
      return [{ text: truncateWidth(" esc close · enter select ", maxWidth), style: { fg: palette.faint } }];
    }

    const input = this.editor.text;
    if (input.startsWith("/") && !input.includes(" ")) {
      const matches = COMMANDS.filter((command) => `/${command.name}`.startsWith(input)).map(
        (command) => `/${command.name}`,
      );
      if (matches.length > 0) {
        return [{ text: truncateWidth(` ${matches.join("  ")}`, maxWidth), style: { fg: palette.faint } }];
      }
    }

    let hint = this.generating ? "esc abort" : `think ${this.options.chat.currentThinking} · /help`;
    if (this.scroll > 0) hint = "pgdn follow · pgup scroll";
    return [{ text: truncateWidth(sanitizeText(` ${hint}`), maxWidth), style: { fg: palette.faint } }];
  }

  private onKey(key: Key): void {
    if (this.exiting) return;

    if (this.approval) {
      this.handleApprovalKey(key);
      return;
    }

    if (this.picker) {
      if (key.name === "click") {
        const hit = this.pickerHits.find((target) => target.row === key.y && (key.x ?? -1) >= target.left && (key.x ?? -1) <= target.right);
        if (hit) {
          this.picker.index = hit.index;
          this.handlePickerKey({ name: "enter" });
        }
        return;
      }
      this.handlePickerKey(key);
      return;
    }

    if (key.name === "wheelup") {
      this.scrollBy(3);
      return;
    }
    if (key.name === "wheeldown") {
      this.scrollBy(-3);
      return;
    }

    if (key.name === "char" && key.ctrl) {
      this.resetCompletion();
      switch (key.text) {
        case "c":
          this.handleCtrlC();
          return;
        case "d":
          if (this.editor.isEmpty) {
            if (this.generating) this.options.chat.abort();
            else this.shutdown();
          }
          return;
        case "l":
          this.screen.clear();
          this.scheduleRender();
          return;
        case "a":
          this.editor.moveHome();
          break;
        case "e":
          this.editor.moveEnd();
          break;
        case "u":
          this.editor.deleteToLineStart();
          break;
        case "k":
          this.editor.deleteToLineEnd();
          break;
        case "w":
          this.editor.deleteWordLeft();
          break;
        case "j":
          this.editor.insert("\n");
          break;
        default:
          return;
      }
      this.scheduleRender();
      return;
    }

    if (key.alt) {
      if (key.name === "enter" || key.name === "newline") {
        this.editor.insert("\n");
        this.resetCompletion();
        this.scheduleRender();
        return;
      }
      if (key.name === "backspace") {
        this.editor.deleteWordLeft();
        this.scheduleRender();
        return;
      }
      if (key.name === "char") {
        if (key.text === "b") this.editor.moveWordLeft();
        else if (key.text === "f") this.editor.moveWordRight();
        else return;
        this.scheduleRender();
      }
      return;
    }

    if (key.shift && (key.name === "up" || key.name === "down")) {
      this.scrollBy(key.name === "up" ? 1 : -1);
      return;
    }

    switch (key.name) {
      case "enter":
        this.submit();
        return;
      case "newline":
        this.editor.insert("\n");
        this.resetCompletion();
        this.scheduleRender();
        return;
      case "tab":
        this.complete();
        return;
      case "backspace":
        this.editor.backspace();
        this.resetCompletion();
        this.scheduleRender();
        return;
      case "delete":
        this.editor.deleteForward();
        this.resetCompletion();
        this.scheduleRender();
        return;
      case "left":
        this.editor.moveLeft();
        this.scheduleRender();
        return;
      case "right":
        this.editor.moveRight();
        this.scheduleRender();
        return;
      case "home":
        this.editor.moveHome();
        this.scheduleRender();
        return;
      case "end":
        this.editor.moveEnd();
        this.scheduleRender();
        return;
      case "up":
        if (this.editor.historyPrev()) this.scheduleRender();
        return;
      case "down":
        if (this.editor.historyNext()) this.scheduleRender();
        return;
      case "pageup":
        this.scrollBy(Math.max(1, this.viewportHeight - 2));
        return;
      case "pagedown":
        this.scrollBy(-Math.max(1, this.viewportHeight - 2));
        return;
      case "escape":
        this.handleEscape();
        return;
      case "char":
        if (key.text !== undefined) {
          this.editor.insert(key.text);
          this.resetCompletion();
          this.scheduleRender();
        }
        return;
      default:
        return;
    }
  }

  private handleCtrlC(): void {
    if (this.generating) {
      this.options.chat.abort();
      return;
    }
    if (!this.editor.isEmpty) {
      this.editor.clear();
      this.scheduleRender();
      return;
    }
    this.shutdown();
  }

  private requestApproval(request: ToolApprovalRequest): Promise<boolean> {
    if (this.exiting) return Promise.resolve(false);
    if (this.approveAll) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      this.approval = {
        request,
        finish: (allow: boolean) => {
          this.approval = null;
          resolve(allow);
          if (!this.exiting) this.scheduleRender();
        },
      };
      this.scheduleRender();
    });
  }

  private handleApprovalKey(key: Key): void {
    const approval = this.approval;
    if (!approval) return;
    const text = key.text?.toLowerCase();

    if (key.name === "escape" || (key.name === "char" && key.ctrl && text === "c")) {
      approval.finish(false);
      return;
    }
    if (key.name === "enter" || (key.name === "char" && text === "y")) {
      approval.finish(true);
      return;
    }
    if (key.name === "char" && text === "a") {
      this.approveAll = true;
      approval.finish(true);
      return;
    }
    if (key.name === "char" && text === "n") {
      approval.finish(false);
    }
  }

  private handleEscape(): void {
    if (this.generating) {
      this.options.chat.abort();
      return;
    }
    if (!this.editor.isEmpty) {
      this.editor.clear();
      this.scheduleRender();
    }
  }

  private scrollBy(delta: number): void {
    const max = Math.max(0, this.lastTotalLines - this.viewportHeight);
    this.scroll = Math.max(0, Math.min(max, this.scroll + delta));
    this.scheduleRender();
  }

  private submit(): void {
    const text = this.editor.text.trim();
    if (!text) return;

    if (text.startsWith("/")) {
      this.editor.clear();
      this.editor.pushHistory(text);
      this.resetCompletion();
      this.scheduleRender();
      void this.runCommand(text);
      return;
    }

    if (this.options.chat.busy) {
      this.transcript.notice("Still generating — press Esc to abort.", "warn");
      this.scheduleRender();
      return;
    }

    this.editor.pushHistory(text);
    this.editor.clear();
    this.scroll = 0;
    this.lastTotalLines = 0;
    this.transcript.clearNotices();
    this.scheduleRender();

    void this.options.chat.send(text).catch((error) => {
      this.transcript.notice(errorMessage(error), "error");
      this.scheduleRender();
    });
  }

  private async runCommand(input: string): Promise<void> {
    const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(input.trim());
    if (!match) return;
    const name = match[1]!.toLowerCase();
    const argument = (match[2] ?? "").trim();

    try {
      switch (name) {
        case "help":
          this.showHelp();
          break;
        case "model":
          if (argument) await this.setModel(argument);
          else await this.openModelPicker();
          break;
        case "new":
          await this.newSession();
          break;
        case "sessions":
          await this.openSessionPicker();
          break;
        case "retry":
          await this.options.chat.retry();
          break;
        case "compact":
          await this.compactSession();
          break;
        case "memory":
          this.showMemory();
          break;
        case "tools":
          this.showTools();
          break;
        case "reasoning":
          this.toggleReasoning();
          break;
        case "think":
        case "thinking":
          if (argument) { await this.options.chat.setThinking(argument); await this.saveModelPreference(); }
          else await this.openThinkingPicker();
          break;
        case "context":
        case "ctx":
          if (argument) { await this.options.chat.setContextSize(Number(argument)); await this.saveModelPreference(); }
          else await this.openContextPicker();
          break;
        case "parallel":
          await this.openParallelPicker();
          break;
        case "clear":
          this.transcript.clearView();
          this.scroll = 0;
          this.lastTotalLines = 0;
          break;
        case "export":
          await this.exportSession(argument);
          break;
        case "info":
          this.showInfo();
          break;
        case "quit":
        case "exit":
          this.shutdown();
          return;
        default:
          this.transcript.notice(`Unknown command: /${name}. Try /help.`, "warn");
      }
    } catch (error) {
      this.transcript.notice(errorMessage(error), "error");
    }
    this.scheduleRender();
  }

  private showHelp(): void {
    const commandLines = COMMANDS.map(
      (command) => `/${command.name}${" ".repeat(Math.max(1, 12 - command.name.length))}${command.description}`,
    );
    this.transcript.notice(
      [
        "Commands",
        ...commandLines,
        "",
        "Keys",
        "enter send · alt+enter / ctrl+j newline · tab complete",
        "↑/↓ history · mouse wheel scroll · shift+↑/↓ and pgup/pgdn scroll",
        "esc abort/clear · ctrl+c abort/clear/exit · ctrl+d exit",
        "tool approval: y allow · a allow all · n / esc deny",
      ].join("\n"),
      "info",
    );
  }

  private async setModel(model: string): Promise<void> {
    await this.options.chat.setModel(model);
    await this.options.onModelChange?.(model);
    this.transcript.notice(`Model set to ${model}.`, "info");
    await this.openThinkingPicker(true);
  }

  private async saveModelPreference(): Promise<void> {
    const model = this.options.chat.currentModel;
    if (!model) return;
    const preference = { thinking: this.options.chat.currentThinking, numCtx: this.options.chat.contextLimit };
    this.options.config.models[model] = { ...preference };
    this.options.persistedConfig.models[model] = { ...preference };
    await this.persistConfig();
  }

  private async openThinkingPicker(setup = false): Promise<void> {
    const details = await this.options.chat.getModelDetails();
    this.modelSetup = setup;
    const items = details.thinking.modes.map((mode) => ({
      value: mode,
      label: mode === "off" ? "Off" : mode === "on" ? "On" : mode,
      detail: mode === "off" ? "no reasoning generation" : "model-supported reasoning mode",
    }));
    if (!details.thinking.modes.includes("off")) {
      items.unshift({ value: "unsupported-off", label: "Off — unavailable for this model", detail: "Choose a supported level" });
    }
    this.picker = new Picker({
      title: "Thinking mode",
      items: items.map((item) => ({ ...item, disabled: item.value === "unsupported-off" })),
      selected: this.options.chat.currentThinking === "auto" ? details.thinking.defaultMode : this.options.chat.currentThinking,
      showFilter: false,
      message: details.thinking.note ?? (details.thinking.control === "none" ? "This model does not generate thinking." : undefined),
    });
    this.pickerKind = "thinking";
    this.scheduleRender();
  }

  private async openContextPicker(): Promise<void> {
    const details = await this.options.chat.getModelDetails();
    const maximum = details.contextLength ?? 131_072;
    const values = [...new Set([2048, 4096, 8192, 12288, 16384, 32768, 65536, maximum, this.options.chat.contextLimit])]
      .filter((value) => value <= maximum).sort((a, b) => a - b);
    this.picker = new Picker({
      title: "Ollama context window",
      items: [...values.map((value) => ({ value: String(value), label: `${value.toLocaleString("en-US")} tokens`, detail: value > 8192 ? "more KV-cache / VRAM" : "" })),
        { value: "custom", label: "Custom size…", detail: "type /context <tokens>" }],
      selected: String(this.options.chat.contextLimit),
      showFilter: false,
      message: "Applied as num_ctx on the next request. A larger context needs more memory and may reload the model.",
    });
    this.pickerKind = "context";
    this.scheduleRender();
  }

  private async checkParallel(): Promise<void> {
    if (!this.options.runtime) return;
    this.parallel = await this.options.runtime.parallelStatus();
    if (this.parallel.value !== null && this.parallel.value !== 1 && this.parallel.local) {
      if (!this.picker && !this.approval && !this.generating) await this.openParallelPicker();
      else this.transcript.notice(`Ollama parallel=${this.parallel.value}. Recommend 1 for a single agent; use /parallel.`, "warn");
    }
    this.scheduleRender();
  }

  private async openParallelPicker(): Promise<void> {
    if (!this.options.runtime) {
      this.transcript.notice("Parallel configuration is available for local Ollama startup only.", "info");
      return;
    }
    this.parallel = await this.options.runtime.parallelStatus();
    this.picker = new Picker({
      title: `Ollama parallel: ${this.parallel.value ?? "unknown"}`,
      message: `One agent needs one parallel slot. Extra slots multiply KV-cache and can move layers to CPU. Detected via ${this.parallel.source}. Existing Ollama needs a restart after saving.`,
      showFilter: false,
      selected: "keep",
      items: [
        { value: "set-one", label: "Set parallel = 1", detail: process.platform === "win32" ? "save Windows user environment" : "use for TinyCode-managed startup", disabled: !this.parallel.canSet },
        { value: "keep", label: "Keep current setting", detail: "no changes" },
      ],
    });
    this.pickerKind = "parallel";
    this.scheduleRender();
  }

  private async openModelPicker(): Promise<void> {
    this.loadingText = "loading models from Ollama…";
    this.scheduleRender();
    try {
      const models = await this.options.chat.listModels();
      if (models.length === 0) {
        this.transcript.notice(
          "No models found. Pull one first, for example: ollama pull qwen2.5-coder:7b",
          "warn",
        );
        return;
      }
      const items: PickerItem[] = models.map((model) => {
        const details = [
          model.parameterSize,
          model.quantization,
          model.sizeBytes ? formatBytes(model.sizeBytes) : undefined,
        ].filter((value): value is string => Boolean(value));
        return { value: model.id, label: model.id, detail: details.join(" · ") };
      });
      this.pickerKind = "model";
      this.picker = new Picker({
        title: "Select model",
        placeholder: "Filter models…",
        items,
        selected: this.options.chat.currentModel,
      });
    } catch (error) {
      this.transcript.notice(errorMessage(error), "error");
    } finally {
      this.loadingText = null;
      this.scheduleRender();
    }
  }

  private async openSessionPicker(): Promise<void> {
    this.loadingText = "loading sessions…";
    this.scheduleRender();
    try {
      const sessions = await this.options.chat.listSessions();
      if (sessions.length === 0) {
        this.transcript.notice("No saved sessions yet.", "info");
        return;
      }
      const items: PickerItem[] = sessions.map((session) => ({
        value: session.id,
        label: session.title,
        detail: `${session.id} · ${session.messageCount} msgs · ${relativeTime(session.updatedAt)}`,
      }));
      this.pickerKind = "session";
      this.picker = new Picker({
        title: "Switch session",
        placeholder: "Filter sessions…",
        items,
        selected: this.options.chat.current?.meta.id ?? null,
      });
    } catch (error) {
      this.transcript.notice(errorMessage(error), "error");
    } finally {
      this.loadingText = null;
      this.scheduleRender();
    }
  }

  private handlePickerKey(key: Key): void {
    const picker = this.picker;
    if (!picker) return;
    const result = picker.handleKey(key);
    if (result.type === "cancel") {
      this.picker = null;
      this.pickerKind = null;
      this.modelSetup = false;
      this.scheduleRender();
      return;
    }
    if (result.type === "update") {
      this.scheduleRender();
      return;
    }
    if (result.type === "select") {
      const kind = this.pickerKind;
      this.picker = null;
      this.pickerKind = null;
      void this.applyPickerSelection(kind, result.item);
      return;
    }
  }

  private async applyPickerSelection(kind: PickerKind | null, item: PickerItem): Promise<void> {
    try {
      if (kind === "model") {
        await this.setModel(item.value);
      } else if (kind === "thinking") {
        await this.options.chat.setThinking(item.value);
        await this.saveModelPreference();
        this.transcript.notice(`Thinking: ${item.label}.`, "info");
        if (this.modelSetup) { this.modelSetup = false; await this.openContextPicker(); }
      } else if (kind === "context") {
        if (item.value === "custom") this.editor.setText("/context ");
        else {
          await this.options.chat.setContextSize(Number(item.value));
          await this.saveModelPreference();
          this.transcript.notice(`Context: ${item.label}; used by the next Ollama request.`, "info");
        }
      } else if (kind === "parallel" && item.value === "set-one" && this.options.runtime) {
        this.parallel = await this.options.runtime.setParallelOne();
        this.options.persistedConfig.ollama.parallel = 1;
        this.options.config.ollama.parallel = 1;
        await this.persistConfig();
        this.transcript.notice(this.parallel.restartRequired
          ? "Saved parallel=1. Completely restart the existing Ollama application/server to apply it; TinyCode did not stop your server."
          : "Managed Ollama restarted with parallel=1.", "info");
      } else if (kind === "session") {
        if (this.options.chat.busy) {
          this.options.chat.abort();
          await this.options.chat.waitForIdle();
        }
        await this.options.chat.resume(item.value);
        this.transcript.reset();
        this.sessionId = item.value;
        this.scroll = 0;
        this.lastTotalLines = 0;
        this.transcript.notice(`Resumed ${item.value}.`, "info");
        await this.checkParallel();
      }
    } catch (error) {
      this.transcript.notice(errorMessage(error), "error");
    }
    this.scheduleRender();
  }

  private async newSession(): Promise<void> {
    if (this.options.chat.busy) {
      this.options.chat.abort();
      await this.options.chat.waitForIdle();
    }
    await this.options.chat.createSession();
    this.transcript.reset();
    this.sessionId = null;
    this.scroll = 0;
    this.lastTotalLines = 0;
    this.transcript.notice("New session started.", "info");
    await this.checkParallel();
    this.scheduleRender();
  }

  private toggleReasoning(): void {
    this.transcript.showReasoning = !this.transcript.showReasoning;
    this.options.config.ui.showReasoning = this.transcript.showReasoning;
    this.options.persistedConfig.ui.showReasoning = this.transcript.showReasoning;
    void this.persistConfig();
    this.transcript.notice(
      `Thinking output ${this.transcript.showReasoning ? "enabled" : "hidden"}.`,
      "info",
    );
  }

  private async compactSession(): Promise<void> {
    const result = await this.options.chat.compact();
    if (!result.compacted) {
      this.transcript.notice(result.reason, "info");
      return;
    }
    this.transcript.notice(
      `Compacted ${result.sourceMessages} messages into ${result.summaryChars} chars (${result.strategy}).`,
      "info",
    );
  }

  private showMemory(): void {
    const compaction = this.options.chat.current?.meta.compaction;
    if (!compaction) {
      this.transcript.notice("This session has no compacted memory yet. Use /compact.", "info");
      return;
    }
    this.transcript.notice(
      `Compacted memory (${compaction.sourceMessageCount} messages · ${compaction.strategy})\n\n${compaction.summary}`,
      "info",
    );
  }

  private showTools(): void {
    const lines = this.options.chat.toolDefinitions.map(
      (tool) => `${tool.safe ? "○" : "◆"} ${tool.name} — ${tool.description}`,
    );
    this.transcript.notice(
      [
        `${lines.length} tools (◆ requires approval)`,
        ...lines,
      ].join("\n"),
      "info",
    );
  }

  private async persistConfig(): Promise<void> {
    try {
      await saveConfig(this.options.persistedConfig);
    } catch (error) {
      this.transcript.notice(`Could not save config: ${errorMessage(error)}`, "warn");
    }
  }

  private showInfo(): void {
    const session = this.options.chat.current;
    if (!session) return;
    this.transcript.notice(
      [
        `Session   ${session.meta.id}`,
        `Title     ${singleLine(session.meta.title)}`,
        `Model     ${session.meta.model}`,
        `Cwd       ${session.meta.cwd}`,
        `Messages  ${session.messages.length}`,
        `Context   up to ${this.options.config.context.maxMessages} messages / ${this.options.config.context.maxChars} chars`,
        `Pressure  ${(this.options.chat.contextPressure * 100).toFixed(0)}% · auto compact at ${(this.options.config.compaction.threshold * 100).toFixed(0)}%`,
        `Tools     ${this.options.chat.toolsEnabled ? `enabled · ${this.options.chat.toolCount}` : "disabled"}${
          this.options.chat.toolsEnabled
            ? ` · approval ${this.options.config.tools.autoApprove ? "auto" : "ask"}`
            : ""
        }`,
        `Prompt    ${this.options.promptSource ?? "built-in"}`,
        `Compact   ${session.meta.compaction
          ? `${session.meta.compaction.sourceMessageCount} messages · ${session.meta.compaction.summary.length} chars · ${session.meta.compaction.strategy}`
          : this.options.config.compaction.enabled
            ? `ready · auto ${this.options.config.compaction.auto ? "on" : "off"}`
            : "disabled"}`,
        `Compact prompt ${this.options.compactionPromptSource ?? "built-in"}`,
        `Config    ${this.options.configPath}`,
      ].join("\n"),
      "info",
    );
  }

  private async exportSession(argument: string): Promise<void> {
    const session = this.options.chat.current;
    if (!session) return;
    const expanded = argument
      ? argument.replace(/^~(?=$|[\\/])/, os.homedir())
      : `tinycode-${session.meta.id}.md`;
    const target = path.isAbsolute(expanded) ? expanded : path.resolve(session.meta.cwd || this.options.cwd, expanded);
    await writeFile(target, sessionToMarkdown(session), "utf8");
    this.transcript.notice(`Exported to ${target}`, "info");
  }

  private complete(): void {
    const text = this.editor.text;
    if (!text.startsWith("/") || text.includes(" ")) return;
    const prefix = text.toLowerCase();
    const matches = COMMANDS.filter((command) => `/${command.name}`.startsWith(prefix)).map(
      (command) => `/${command.name}`,
    );
    if (matches.length === 0) return;
    if (this.completionInput !== text) {
      this.completionInput = text;
      this.completionIndex = 0;
    } else {
      this.completionIndex = (this.completionIndex + 1) % matches.length;
    }
    this.editor.replaceText(`${matches[this.completionIndex]} `);
    this.scheduleRender();
  }

  private resetCompletion(): void {
    this.completionInput = "";
    this.completionIndex = 0;
  }

  private shutdown(): void {
    if (this.exiting) return;
    this.exiting = true;
    if (this.approval) {
      const approval = this.approval;
      this.approval = null;
      approval.finish(false);
    }
    this.options.chat.abort();
    this.parser.dispose();
    void this.options.chat.waitForIdle().finally(() => this.resolveExit?.());
  }

  private cleanup(): void {
    this.exiting = true;
    if (this.approval) {
      const approval = this.approval;
      this.approval = null;
      approval.finish(false);
    }
    this.parser.dispose();
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }
    for (const unsubscribe of this.unsubs) unsubscribe();
    this.unsubs.length = 0;
    if (this.signalHandler) {
      process.off("SIGTERM", this.signalHandler);
      process.off("SIGHUP", this.signalHandler);
      this.signalHandler = null;
    }
    this.terminal.stop();
  }

  private async loadHistory(): Promise<void> {
    try {
      const entries = await readJson<string[]>(historyFile());
      if (Array.isArray(entries)) this.editor.loadHistory(entries);
    } catch {
      // History is a convenience; a broken file must not block startup.
    }
  }

  private async saveHistory(): Promise<void> {
    try {
      await writeJsonAtomic(historyFile(), this.editor.historySnapshot());
    } catch {
      // Best effort.
    }
  }
}
