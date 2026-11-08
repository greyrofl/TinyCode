import os from "node:os";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import type { Bus } from "../core/bus.js";
import type { ChatService } from "../core/chat.js";
import type { Config } from "../core/config/config.js";
import { saveConfig } from "../core/config/config.js";
import { sessionToMarkdown } from "../core/session/export.js";
import type { SessionMeta } from "../core/session/types.js";
import type { ChatStatus } from "../core/types.js";
import type { ParallelStatus, HardwareMemoryStatus, LocalRuntime } from "../core/runtime.js";
import { calculateContextCapacity, contextCapacityMessage, contextChoices, type ContextCapacity } from "../core/context-memory.js";
import { recommendModels, type ModelRecommendation } from "../core/model-recommendations.js";
import type { RunningModelInfo } from "../core/provider/types.js";
import {
  INFERENCE_PROFILE_IDS,
  inferenceProfileLabel,
  isInferenceProfile,
  isMtpProfile,
  type InferenceProfileId,
} from "../core/inference-profile.js";
import { displayWidth, padEndWidth, truncateWidth } from "../util/ansi.js";
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
import { fitLine, lineWidth, spaces } from "./types.js";

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
  runtime?: LocalRuntime;
  startupNotices?: Array<{ text: string; level: "info" | "warn" | "error" }>;
}

type PickerKind = "provider" | "model" | "recommendation" | "session" | "thinking" | "inference" | "draft-model" | "context" | "parallel";

const COMMANDS: Array<{ name: string; description: string }> = [
  { name: "help", description: "show commands and keys" },
  { name: "model", description: "select or set a model" },
  { name: "models", description: "models grouped by engine" },
  { name: "provider", description: "choose llama.cpp or Ollama" },
  { name: "recommend", description: "models estimated to fit this hardware" },
  { name: "new", description: "start a new session" },
  { name: "sessions", description: "switch session" },
  { name: "retry", description: "regenerate the last answer" },
  { name: "goal", description: "set task completion goal" },
  { name: "compact", description: "compress older session turns" },
  { name: "memory", description: "show compacted session memory" },
  { name: "tools", description: "show available agent tools" },
  { name: "reasoning", description: "toggle thinking output" },
  { name: "think", description: "choose the model's thinking mode" },
  { name: "inference", description: "Standard, N-gram, or Gemma MTP profile" },
  { name: "context", description: "set the engine's context window" },
  { name: "parallel", description: "check/set local engine parallel" },
  { name: "profile", description: "tools: auto, plan, edit, full; model restores default" },
  { name: "clear", description: "clear the screen" },
  { name: "export", description: "save the session as Markdown" },
  { name: "info", description: "show session details" },
  { name: "quit", description: "exit tinycode" },
];

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** A failed context allocation should degrade to the small baseline once. */
const FALLBACK_CONTEXT = 8192;
const OUT_OF_MEMORY = /out.of.memory|outofdevicememory|cuda error|failed to allocate|alloc(?:ation|ating)[^\n]*failed|requires more[^\n]*memory|insufficient[^\n]*memory|not enough[^\n]*memory/i;

function isOutOfMemory(error: unknown): boolean {
  return OUT_OF_MEMORY.test(errorMessage(error));
}

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
  private sessionTabs: SessionMeta[] = [];
  private tabHits: Array<{ left: number; right: number; sessionId?: string; close?: boolean; create?: boolean; sessions?: boolean }> = [];
  private parallel: ParallelStatus | null = null;
  private contextCapacity: ContextCapacity | null = null;
  private runningSnapshot: RunningModelInfo | null = null;
  private contextReadyModel: string | null = null;
  private changingContext = false;
  private contextChange: Promise<void> | null = null;
  private contextRestartController: AbortController | null = null;
  private runnerRecoveryRequired = false;
  private readonly recommendations = new Map<string, ModelRecommendation>();
  private contextSelection: { finish(value: number | null, error?: unknown): void; signal: AbortSignal } | null = null;
  private continueModelSetup = false;
  private pendingInferenceProfile: InferenceProfileId | null = null;
  private sessionId: string | null = null;
  private approval: { request: ToolApprovalRequest; finish: (allow: boolean) => void } | null = null;
  private approveAll = false;

  private scroll = 0;
  private viewportHeight = 1;
  private lastTotalLines = 0;
  private transcriptStart = 0;
  private transcriptAreaTop = 0;

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
      await Promise.all([this.loadHistory(), this.refreshSessionTabs()]);
      this.attach();
      for (const notice of this.options.startupNotices ?? []) this.transcript.notice(notice.text, notice.level);
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
      bus.on("message.ended", ({ message }) => {
        if (/out.of.memory|CUDA|server startup|TerminateProcess/i.test(message.error ?? "")) {
          this.runnerRecoveryRequired = true;
          this.contextReadyModel = null;
        }
        this.scheduleRender();
      }),
      bus.on("session.changed", ({ meta }) => {
        this.upsertSessionTab(meta);
        this.scheduleRender();
      }),
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
      status.state === "tool" ||
      status.state === "evaluating";
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
      this.options.chat.busy || this.loadingText !== null || this.changingContext ||
      state === "connecting" ||
      state === "compacting" ||
      state === "thinking" ||
      state === "responding" ||
      state === "tool" ||
      state === "evaluating"
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
      this.transcript.sync(session.messages, session.meta.queuedInputs);
    }

    const headerHeight = height >= 16 ? 3 : 2;
    const footerHeight = height >= 10 ? 1 : 0;
    const maxComposerLines = Math.max(1, Math.min(7, height - headerHeight - footerHeight - 3));
    const composer = this.buildComposer(width, maxComposerLines);
    const areaTop = headerHeight;
    const areaHeight = Math.max(1, height - headerHeight - footerHeight - composer.lines.length);
    this.viewportHeight = areaHeight;

    const frame: Line[] = Array.from({ length: height }, () => []);
    frame[0] = this.buildSessionTabs(width);
    frame[1] = this.buildHeader(width);
    if (headerHeight === 3) {
      frame[2] = [{ text: "─".repeat(width), style: { fg: this.palette.border } }];
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
    this.transcriptStart = start;
    this.transcriptAreaTop = areaTop;
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
      ...(width >= 34 ? [{ text: ` ${version()}`, style: { fg: palette.faint } }] : []),
    ];

    const model = sanitizeText((this.options.chat.currentModel ?? this.options.config.model).split(/[\\/]/).at(-1) ?? "");
    const rightBudget = Math.max(0, Math.min(40, width - lineWidth(left) - 1));
    const engine = truncateWidth(this.options.chat.engineName, rightBudget);
    const engineWidth = displayWidth(engine);
    const modelBudget = Math.max(0, rightBudget - engineWidth - 3);
    const right: Line = rightBudget > 0 ? [
      { text: engine, style: { fg: palette.faint } },
      ...(modelBudget >= 4 ? [
        { text: " · ", style: { fg: palette.faint } },
        { text: truncateWidth(model || "select model", modelBudget), style: { fg: palette.muted } },
      ] : []),
    ] : [];

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
    return fitLine([...left, ...middle, ...spaces(padding), ...right], width);
  }

  private buildSessionTabs(width: number): Line {
    this.tabHits = [];
    const active = this.options.chat.current?.meta.id;
    const visible = this.sessionTabs;
    const ordered = [
      ...visible.filter((session) => session.id === active),
      ...visible.filter((session) => session.id !== active),
    ];
    const line: Line = [];
    let column = 0;
    let rendered = 0;
    const reserve = 5;
    for (const session of ordered) {
      const selected = session.id === active;
      const available = width - column - reserve;
      if (available < 9) break;
      const maxTitle = Math.max(4, Math.min(24, available - (selected ? 4 : 2)));
      const title = truncateWidth(sanitizeText(singleLine(session.title || "New session")), maxTitle);
      const before = ` ${title} `;
      const close = selected ? "× " : "";
      const tabWidth = displayWidth(before + close);
      if (column + tabWidth + reserve > width) break;
      line.push({ text: before, style: { fg: selected ? this.palette.text : this.palette.muted, bg: selected ? this.palette.panelAlt : this.palette.panel, bold: selected } });
      if (selected) line.push({ text: close, style: { fg: this.palette.faint, bg: this.palette.panelAlt } });
      this.tabHits.push({ left: column, right: column + tabWidth - 1, sessionId: session.id });
      if (selected) this.tabHits.push({ left: column + tabWidth - displayWidth(close), right: column + tabWidth - 1, sessionId: session.id, close: true });
      column += tabWidth;
      line.push({ text: "│", style: { fg: this.palette.border, bg: this.palette.panel } });
      column++;
      rendered++;
    }
    const hidden = Math.max(0, ordered.length - rendered);
    if (hidden && column + 4 < width) {
      const text = ` +${hidden} `;
      line.push({ text, style: { fg: this.palette.faint, bg: this.palette.panel } });
      this.tabHits.push({ left: column, right: column + displayWidth(text) - 1, sessions: true });
      column += displayWidth(text);
    }
    if (column + 3 <= width) {
      const text = " + ";
      line.push({ text, style: { fg: this.palette.accent, bg: this.palette.panel, bold: true } });
      this.tabHits.push({ left: column, right: column + 2, create: true });
      column += 3;
    }
    if (column < width) line.push({ text: " ".repeat(width - column), style: { bg: this.palette.panel } });
    return fitLine(line, width);
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
    const panelWidth = Math.max(28, Math.min(64, width - 4));
    const inside = panelWidth - 4;
    const model = (this.options.chat.currentModel ?? this.options.config.model).split(/[\\/]/).at(-1) ?? "";
    const fields: Array<{ label: string; value: string; hint: string }> = [
      { label: "model", value: model || "select a local model", hint: "/models" },
      { label: "thinking", value: this.options.chat.currentThinking, hint: "/think" },
      { label: "inference", value: inferenceProfileLabel(this.options.chat.currentInferenceProfile), hint: "/inference" },
      { label: "context", value: `${this.options.chat.contextLimit.toLocaleString("en-US")} tokens`, hint: "/context" },
      { label: "folder", value: shortPath(this.options.chat.current?.meta.cwd ?? this.options.cwd), hint: "" },
    ];

    const border = { fg: palette.border };
    const title = " session ";
    const rows: Line[] = [[
      { text: "╭─", style: border },
      { text: title, style: { fg: palette.accent, bold: true } },
      { text: "─".repeat(Math.max(0, panelWidth - 12)), style: border },
      { text: "╮", style: border },
    ]];

    for (const field of fields) {
      const hint = width >= 58 ? field.hint : "";
      const valueWidth = Math.max(8, inside - 10 - hint.length);
      const value = padEndWidth(
        truncateWidth(sanitizeText(singleLine(field.value)), valueWidth),
        valueWidth,
      );
      rows.push([
        { text: "│ ", style: border },
        { text: field.label.padEnd(10), style: { fg: palette.muted } },
        { text: value, style: { fg: palette.text } },
        { text: hint, style: { fg: palette.accentDim } },
        { text: " │", style: border },
      ]);
    }

    rows.push([{ text: `╰${"─".repeat(panelWidth - 2)}╯`, style: border }]);
    return this.centerBlock(rows, width);
  }

  private welcomeChips(): Line {
    const palette = this.palette;
    const line: Line = [];
    for (const [index, item] of ["/new", "/sessions", "/model", "/help"].entries()) {
      if (index > 0) line.push({ text: "  ·  ", style: { fg: palette.border } });
      line.push({ text: item, style: { fg: palette.accent, bold: true } });
    }
    return line;
  }

  private welcomeLines(width: number, height: number): Line[] {
    const palette = this.palette;
    const fullLogo = buildLogo(palette);
    const full = height >= 18 && logoWidth(fullLogo) + 4 <= width;
    const logo = this.centerBlock(full ? fullLogo : buildLogo(palette, true), width);

    const memory = this.options.config.compaction.auto ? "auto memory" : "manual memory";
    const tagline: Line = [
      { text: "local models", style: { fg: palette.muted } },
      { text: "  ·  ", style: { fg: palette.border } },
      { text: "real code", style: { fg: palette.muted } },
      { text: "  ·  ", style: { fg: palette.border } },
      { text: `${this.options.chat.toolCount} tools`, style: { fg: palette.accentDim } },
      ...(width >= 74
        ? [{ text: "  ·  ", style: { fg: palette.border } }, { text: memory, style: { fg: palette.faint } }]
        : []),
    ];

    let content: Line[] = [
      ...logo,
      ...(width >= 64
        ? [this.centered(tagline, width)]
        : width >= 40
          ? [this.centered([{ text: "local models · real code", style: { fg: palette.muted } }], width)]
          : []),
      [],
      ...this.welcomePanel(width),
      [],
      this.centered(this.welcomeChips(), width),
      ...(height >= 26
        ? [this.centered([{ text: "enter send · alt+enter newline · /help", style: { fg: palette.faint } }], width)]
        : []),
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
    const contextStyle = { fg: usage.percent >= 90 ? this.palette.error : usage.percent >= 70 ? this.palette.warn : this.palette.accent };
    const context: Line = [
      { text: `${width < 34 ? "" : "ctx "}${usage.percent}%`, style: contextStyle },
      { text: " · ", style: { fg: this.palette.faint } },
      { text: this.options.chat.currentToolProfile, style: { fg: this.palette.accent, bold: true } },
    ];
    if (width >= 72) context.push(
      { text: " · ", style: { fg: this.palette.faint } },
      { text: inferenceProfileLabel(this.options.chat.currentInferenceProfile), style: { fg: this.palette.reasoning } },
    );
    const tokens = width < 50
      ? ` · ${usage.estimated ? "~" : ""}${usage.tokens}/${usage.maxTokens}t`
      : ` · ${usage.estimated ? "~" : ""}${usage.tokens.toLocaleString("en-US")}/${usage.maxTokens.toLocaleString("en-US")} tok`;
    // Keep the percentage and profile visible before optional token detail/hints.
    if (lineWidth(context) + tokens.length <= width) context.push({ text: tokens, style: contextStyle });
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
    if (status.state === "evaluating") {
      const glyph = SPINNER[this.spinner % SPINNER.length]!;
      return [
        { text: `  ${glyph} `, style: { fg: palette.reasoning } },
        { text: status.detail ?? "reviewing goal", style: { fg: palette.muted } },
      ];
    }
    if (status.state === "connecting" || status.state === "thinking" || status.state === "responding") {
      const glyph = SPINNER[this.spinner % SPINNER.length]!;
      const label = status.detail ??
        (status.state === "connecting" ? "processing prompt" : status.state === "thinking" ? "thinking" : "generating response");
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

    if (key.name === "click") {
      if (key.y === 0) {
        const x = key.x ?? -1;
        const hit = this.tabHits.find((target) => target.close && x >= target.left && x <= target.right)
          ?? this.tabHits.find((target) => x >= target.left && x <= target.right);
        if (hit) void this.activateSessionTab(hit);
        return;
      }
      const line = this.transcriptStart + (key.y ?? -1) - this.transcriptAreaTop;
      if (line >= 0 && this.transcript.toggleGoalAt(line)) this.scheduleRender();
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
    if (this.contextRestartController) { this.contextRestartController.abort(); return; }
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
    if (this.contextRestartController) { this.contextRestartController.abort(); return; }
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

    if (this.options.chat.canQueue) {
      this.editor.pushHistory(text);
      this.editor.clear();
      this.scroll = 0;
      this.lastTotalLines = 0;
      this.scheduleRender();
      void this.options.chat.send(text, (signal) => this.preparePromptContext(signal)).catch((error) => {
        this.transcript.notice(errorMessage(error), "error");
        this.scheduleRender();
      });
      return;
    }

    if (this.generating) {
      this.transcript.notice(this.loadingText ? "Model/context setup is still running — press Esc to cancel." : "Still generating — press Esc to abort.", "warn");
      this.scheduleRender();
      return;
    }

    if (!this.options.chat.currentModel) {
      this.transcript.notice("Choose a model first; your message remains in the input.", "info");
      void this.openModelPicker();
      return;
    }

    if (this.options.chat.loadedRunnerContext !== null && this.options.chat.contextLimit < this.options.chat.minimumContextSize) {
      this.transcript.notice(`The current context is too small for profile ${this.options.chat.currentToolProfile}. Choose at least ${this.options.chat.minimumContextSize.toLocaleString("en-US")} tokens.`, "warn");
      void this.openContextPicker();
      this.scheduleRender();
      return;
    }
    this.editor.pushHistory(text);
    this.editor.clear();
    this.scroll = 0;
    this.lastTotalLines = 0;
    this.transcript.clearNotices();
    this.scheduleRender();

    void this.options.chat.send(text, (signal) => this.preparePromptContext(signal)).catch((error) => {
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
        case "models":
          await this.openModelPicker();
          break;
        case "provider":
          if (argument) await this.setProvider(argument);
          else await this.openModelPicker();
          break;
        case "recommend":
          await this.openRecommendationPicker();
          break;
        case "new":
          await this.newSession();
          break;
        case "sessions":
          await this.openSessionPicker();
          break;
        case "retry":
          await this.options.chat.retry((signal) => this.preparePromptContext(signal));
          break;
        case "goal":
          if (!argument) this.transcript.notice("Usage: /goal <task description>. Use /goal off to clear it.", "info");
          else if (argument.toLowerCase() === "off") await this.options.chat.clearGoal();
          else await this.options.chat.setGoal(argument);
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
        case "inference":
          if (argument) {
            const parsed = /^(\S+)(?:\s+([\s\S]+))?$/.exec(argument);
            if (!parsed || !isInferenceProfile(parsed[1])) throw new Error("Usage: /inference standard|ngram|mtp-2|mtp-3|mtp-6|mtp-8 [draft.gguf]");
            const draft = parsed[2]?.trim().replace(/^(["'])([\s\S]*)\1$/, "$2");
            if (isMtpProfile(parsed[1]) && !draft && !this.options.chat.currentInferenceDraftModel) {
              await this.openDraftModelPicker(parsed[1]);
            } else await this.applyInferenceProfile(parsed[1], draft);
          } else await this.openInferencePicker();
          break;
        case "context":
        case "ctx":
          if (argument) {
            await this.applyContextValue(Number(argument));
          }
          else await this.openContextPicker();
          break;
        case "parallel":
          await this.openParallelPicker();
          break;
        case "profile":
          if (argument) await this.setToolProfile(argument);
          else this.transcript.notice(`Tool profile: ${this.options.chat.currentToolProfile}. Use /profile auto|plan|edit|full, or /profile model for the size-based default.`, "info");
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
    if (this.changingContext) {
      this.contextRestartController?.abort();
      this.options.chat.abort();
      await this.contextChange?.catch(() => {});
    }
    if (this.options.chat.currentProvider === "ollama") await this.options.runtime?.ensureStarted?.();
    await this.options.chat.setModel(model);
    await this.options.onModelChange?.(model);
    this.contextCapacity = null;
    this.runningSnapshot = null;
    this.contextReadyModel = null;
    this.runnerRecoveryRequired = false;
    this.transcript.notice(`Model set to ${model}.`, "info");
    await this.openThinkingPicker(true);
  }

  private async setProvider(id: string, openModels = true): Promise<void> {
    if (this.changingContext) {
      this.contextRestartController?.abort(); this.options.chat.abort();
      await this.contextChange?.catch(() => {});
    }
    const previousProvider = this.options.chat.currentProvider;
    const previousModel = this.options.chat.currentModel ?? "";
    this.loadingText = `Switching to ${id}…`;
    this.scheduleRender();
    try {
      await this.options.chat.setProvider(id);
      this.options.persistedConfig.providerModels[previousProvider] = previousModel;
      this.options.persistedConfig.provider = this.options.config.provider;
      this.options.persistedConfig.model = this.options.chat.currentModel ?? "";
      this.options.persistedConfig.providerModels[id] = this.options.chat.currentModel ?? "";
      await this.persistConfig();
      this.contextCapacity = null; this.runningSnapshot = null; this.contextReadyModel = null; this.parallel = null;
      this.runnerRecoveryRequired = false;
      this.transcript.notice(`Engine: ${this.options.chat.engineName}. Weights are loaded only after a prompt.`, "info");
      if (openModels) await this.openModelPicker();
    } finally {
      this.loadingText = null;
      this.scheduleRender();
    }
  }

  private async saveModelPreference(): Promise<void> {
    const model = this.options.chat.currentModel;
    if (!model) return;
    const key = this.options.chat.modelPreferenceKey;
    const sampling = this.options.config.models[key]?.sampling ?? this.options.persistedConfig.models[key]?.sampling;
    const inference = this.options.config.models[key]?.inference ?? {
      profile: this.options.chat.currentInferenceProfile,
      ...(this.options.chat.currentInferenceDraftModel ? { draftModel: this.options.chat.currentInferenceDraftModel } : {}),
    };
    const preference = { thinking: this.options.chat.currentThinking, numCtx: this.options.chat.contextLimit, ...(sampling ? { sampling } : {}), inference };
    this.options.config.models[key] = { ...preference };
    this.options.persistedConfig.models[key] = { ...preference };
    await this.persistConfig();
  }

  private async setToolProfile(profile: string): Promise<void> {
    if (!["model", "auto", "plan", "edit", "full"].includes(profile)) throw new Error("Profile must be model, auto, plan, edit, or full.");
    const selected = profile === "model" ? "auto" : profile as Config["tools"]["profile"];
    this.options.config.tools.profile = selected;
    this.options.persistedConfig.tools.profile = selected;
    this.options.config.tools.profileByModel = profile === "model";
    this.options.persistedConfig.tools.profileByModel = profile === "model";
    await this.persistConfig();
    this.transcript.notice(`Tool profile: ${this.options.chat.currentToolProfile}${profile === "model" ? " (model default)" : " (manual)"}. It applies to the next model step.`, "info");
  }

  private async openThinkingPicker(setup = false): Promise<void> {
    this.continueModelSetup = setup;
    const details = await this.options.chat.getModelDetails();
    const items: PickerItem[] = details.thinking.modes.map((mode) => ({
      value: mode,
      label: mode === "off" ? "Off" : mode === "on" ? "On" : mode,
      detail: mode === "off" ? "no reasoning generation" : "model-supported reasoning mode",
      tone: mode === "off" ? "muted" as const : "reasoning" as const,
    }));
    if (!details.thinking.modes.includes("off")) {
      items.unshift({ value: "unsupported-off", label: "Off — unavailable for this model", detail: "Choose a supported level", tone: "danger" });
    }
    this.picker = new Picker({
      title: "Thinking mode",
      items: items.map((item) => ({ ...item, disabled: item.value === "unsupported-off" })),
      selected: this.options.chat.currentThinking === "auto" ? details.thinking.defaultMode : this.options.chat.currentThinking,
      showFilter: false,
      message: details.thinking.note ?? (details.thinking.control === "none" ? "This model does not generate thinking." : undefined),
      messageStyle: "info",
    });
    this.pickerKind = "thinking";
    this.scheduleRender();
  }

  private async openInferencePicker(setup = false): Promise<void> {
    this.continueModelSetup = setup;
    const support = await this.options.chat.inferenceSupport();
    const current = this.options.chat.currentInferenceProfile;
    const details: Record<InferenceProfileId, string> = {
      standard: "single target model · maximum compatibility",
      ngram: "prompt lookup speculation · no draft weights",
      "mtp-2": "Gemma MTP sidecar · conservative draft depth",
      "mtp-3": "Gemma MTP sidecar · recommended speed profile",
      "mtp-6": "Gemma MTP sidecar · deeper experimental profile",
      "mtp-8": "Gemma MTP sidecar · maximum experimental depth",
    };
    this.picker = new Picker({
      title: "Inference profile",
      showFilter: false,
      selected: current,
      items: INFERENCE_PROFILE_IDS.map((profile) => ({
        value: profile,
        label: inferenceProfileLabel(profile),
        detail: details[profile],
        disabled: profile !== "standard" && (!support.direct || isMtpProfile(profile) && !support.mtp),
        tone: profile === "standard" ? "success" : profile === "ngram" ? "info"
          : profile === "mtp-2" ? "accent" : profile === "mtp-3" ? "success"
            : profile === "mtp-6" ? "reasoning" : "warning",
      })),
      message: support.note ?? (support.draftModel
        ? `MTP sidecar: ${path.basename(support.draftModel)}. Profile changes apply on the next managed model load.`
        : "MTP requires a compatible local sidecar GGUF. TinyCode never downloads model weights."),
      messageStyle: "muted",
    });
    this.pickerKind = "inference";
    this.scheduleRender();
  }

  private async openDraftModelPicker(profile: InferenceProfileId): Promise<void> {
    const support = await this.options.chat.inferenceSupport();
    if (!support.mtp) throw new Error(support.note ?? "This target model is not compatible with TinyCode's Gemma MTP presets.");
    this.pendingInferenceProfile = profile;
    const candidates = await this.options.chat.listInferenceDraftModels();
    if (!candidates.length) {
      this.pendingInferenceProfile = null;
      this.continueModelSetup = false;
      this.editor.setText(`/inference ${profile} `);
      this.transcript.notice(`No MTP sidecar was found in configured model directories. Complete the command with a local GGUF path, for example: /inference ${profile} D:\\models\\mtp-gemma.gguf`, "info");
      this.scheduleRender();
      return;
    }
    this.picker = new Picker({
      title: `${inferenceProfileLabel(profile)} draft sidecar`,
      placeholder: "Filter local sidecars…",
      items: [
        ...candidates.map((model) => ({ value: model.id, label: model.name, detail: model.sizeBytes ? formatBytes(model.sizeBytes) : "local GGUF", tone: "info" as const })),
        { value: "__custom__", label: "Enter another path…", detail: "local GGUF path", tone: "warning" },
      ],
      message: "Select the MTP sidecar matching the target Gemma model. TinyCode does not verify unrelated weights by filename alone.",
      messageStyle: "muted",
    });
    this.pickerKind = "draft-model";
    this.scheduleRender();
  }

  private async applyInferenceProfile(profile: InferenceProfileId, draftModel?: string): Promise<void> {
    await this.options.chat.setInferenceProfile(profile, draftModel);
    await this.saveModelPreference();
    this.contextReadyModel = null;
    this.contextCapacity = null;
    this.runningSnapshot = null;
    this.continueModelSetup = false;
    this.pendingInferenceProfile = null;
    this.transcript.notice(this.options.chat.currentProvider === "llama.cpp"
      ? `Inference: ${inferenceProfileLabel(profile)}. It applies on the next managed llama.cpp model load.`
      : "Inference: Standard. Speculative profiles are controlled only by managed llama.cpp.", "info");
  }

  private async openContextPicker(capacity = this.contextCapacity, setup = false): Promise<void> {
    const details = await this.options.chat.getModelDetails();
    const maximum = details.contextLength ?? 131_072;
    const minimum = this.options.chat.minimumContextSize;
    const estimatedMaximum = capacity?.maximum ?? maximum;
    // llama.cpp can rebalance weight offload during a physical reload (`--fit`).
    // Free memory after the small baseline is therefore guidance, not a hard
    // ceiling. Ollama has scheduler allocation telemetry, so its estimate can
    // remain enforced as before.
    const advisoryEstimate = this.options.chat.currentProvider === "llama.cpp";
    const selectableMaximum = advisoryEstimate ? maximum : estimatedMaximum;
    const values = contextChoices(maximum, this.options.chat.contextLimit, selectableMaximum, minimum);
    this.picker = new Picker({
      title: `${this.options.chat.engineName} context window`,
      items: [...values.map((value) => {
        const details: string[] = [];
        if (value < minimum) details.push(`needs ≥${minimum.toLocaleString("en-US")}`);
        else if (capacity && value > capacity.maximum) details.push(advisoryEstimate ? "above estimate · verify on reload" : "above estimate");
        if (capacity?.vramMaximum !== null && capacity?.vramMaximum !== undefined && value > capacity.vramMaximum) details.push("RAM ctx");
        if (value === maximum) details.push("model limit");
        else if (capacity && value === capacity.maximum) details.push(capacity.exact ? "estimated to model limit" : "estimated fit");
        if (value === this.options.chat.contextLimit) details.push("current");
          return {
            value: String(value),
            label: `${value.toLocaleString("en-US")} tokens`,
            detail: details.join(" · "),
            disabled: value < minimum || Boolean(!advisoryEstimate && capacity && value > capacity.maximum),
            tone: value < minimum ? "danger" as const : value === this.options.chat.contextLimit ? "success" as const
              : capacity && value > capacity.maximum ? "warning" as const
                : value === maximum ? "info" as const : "accent" as const,
          };
      }),
        ...(setup ? [] : [{ value: "custom", label: "Custom size…", detail: "type /context <tokens>", tone: "warning" as const }])],
      selected: String(this.options.chat.contextLimit <= selectableMaximum ? this.options.chat.contextLimit : selectableMaximum),
      showFilter: false,
      message: capacity
        ? advisoryEstimate
          ? `${contextCapacityMessage(capacity).replace(/^Max context:/, "Estimated fit:")} Model limit: ${maximum.toLocaleString("en-US")} tokens. Larger choices are allowed and verified during reload. Changed context requires a controlled llama.cpp restart.`
          : `${contextCapacityMessage(capacity)} Changed context requires a controlled ${this.options.chat.engineName} restart.`
        : `Model limit: ${maximum.toLocaleString("en-US")} tokens. Live memory estimate unavailable.`,
      messageStyle: capacity ? "info" : "warning",
    });
    this.pickerKind = "context";
    this.updateContextPickerFooter();
    this.scheduleRender();
  }

  /**
   * Start the runner at the context saved for this model. The old flow always
   * warmed up at min(context, 8k) and then restarted to the real size, which
   * looked like a restart even when the user picked the same value. If the
   * saved size cannot be allocated, retry once at 8k; callers persist that
   * smaller size so the next start does not repeat the failed allocation.
   */
  private async loadModelWithFallback(
    signal: AbortSignal,
    model: string,
    desired: number,
  ): Promise<{ running: RunningModelInfo; tokens: number }> {
    const before = await this.readMemoryStatus();
    try {
      const running = await this.options.chat.loadCurrentModel(signal, desired);
      if (!running) throw new Error(`${this.options.chat.engineName} did not report a loaded model.`);
      return { running, tokens: desired };
    } catch (error) {
      const fallback = Math.min(FALLBACK_CONTEXT, desired);
      if (signal.aborted || desired <= fallback || !isOutOfMemory(error)) throw error;
      this.transcript.notice(
        `${this.options.chat.engineName} could not load ${model} with ${desired.toLocaleString("en-US")} context (${errorMessage(error)}). Retrying with ${fallback.toLocaleString("en-US")}.`,
        "warn",
      );
      this.options.chat.clearLoadedRunner();
      try { await this.options.runtime?.restartServer?.(signal); } catch { /* External/remote engines keep their server. */ }
      const baselineFree = before?.gpus.reduce((sum, gpu) => sum + gpu.freeBytes, 0);
      await this.options.runtime?.waitForMemoryRelease?.(before, 0, signal,
        baselineFree === undefined ? undefined : Math.max(0, baselineFree - 256 * 1024 ** 2));
      await this.options.chat.setContextSize(fallback, { duringSetup: true });
      const running = await this.options.chat.loadCurrentModel(signal, fallback);
      if (!running) throw new Error(`${this.options.chat.engineName} did not report a loaded model after reducing the context.`);
      this.transcript.notice(`Context reduced to ${fallback.toLocaleString("en-US")} tokens after out-of-memory.`, "info");
      return { running, tokens: fallback };
    }
  }

  private async preparePromptContext(signal: AbortSignal): Promise<void> {
    const model = this.options.chat.currentModel ?? this.options.config.model;
    if (!this.options.chat.managesRunner) {
      this.loadingText = `Connecting to ${this.options.chat.engineName}…`;
      this.scheduleRender();
      try {
        await this.options.runtime?.ensureStarted?.(signal);
        await this.options.chat.getModelDetails();
        this.contextReadyModel = model;
      } finally {
        this.loadingText = null;
        this.scheduleRender();
      }
      return;
    }
    let running = await this.options.chat.getRunningModel(signal).catch((error) => {
      if (signal.aborted) throw error;
      return null; // A stopped Ollama daemon is started below, before retrying /api/ps.
    });
    if (running && !this.runnerRecoveryRequired && this.contextReadyModel === model && this.options.chat.loadedRunnerContext === this.options.chat.contextLimit &&
      running.contextLength >= this.options.chat.contextLimit) return;
    this.loadingText = running ? `Inspecting model ${model}…` : `Loading model ${model}…`;
    this.transcript.notice(this.loadingText, "info");
    this.scheduleRender();
    try {
      await this.options.runtime?.ensureStarted?.(signal);
      if (!running) running = await this.options.chat.getRunningModel(signal);
      const [details, hardware, parallel] = await Promise.all([
        this.options.chat.getModelDetails(),
        this.readMemoryStatus(),
        this.options.runtime?.parallelStatus?.() ?? Promise.resolve({ value: null, source: "unavailable", local: false, canSet: false }),
      ]);
      if (signal.aborted || this.exiting) throw new Error("Model loading cancelled.");
      this.parallel = parallel;
      // Start from the context already saved for this model instead of a
      // temporary 8k baseline. The picker then sees the same physical size and
      // selecting it does not unload/reload the runner.
      const loadContext = Math.max(256, Math.min(details.contextLength ?? this.options.chat.contextLimit, this.options.chat.contextLimit));
      if (!running) {
        this.options.chat.clearLoadedRunner();
        const loaded = await this.loadModelWithFallback(signal, model, loadContext);
        running = loaded.running;
        if (loaded.tokens !== loadContext) await this.saveModelPreference();
      } else if (this.options.chat.loadedRunnerContext === null) {
        // Adopt an already loaded runner without changing its physical context.
        // This also covers a TUI started after the engine, where the cache is
        // empty even though /props or /api/ps reports the right context.
        const adopted = await this.options.chat.loadCurrentModel(signal, running.contextLength);
        if (adopted) running = adopted;
      }
      if (!running) throw new Error(`${this.options.chat.engineName} loaded the model but did not report its runner allocation.`);
      if (signal.aborted || this.exiting) throw new Error("Model loading cancelled.");
      const afterLoad = await this.readMemoryStatus() ?? hardware;
      const measured = calculateContextCapacity({
        details,
        running,
        hardware: afterLoad,
        parallel: parallel.value,
        requestedContext: this.options.chat.loadedRunnerContext ?? running.contextLength,
        forceCpu: this.options.chat.cpuOnly,
      });
      this.runningSnapshot = running;
      this.contextCapacity = measured;
      this.loadingText = null;
      this.transcript.notice(`Model loaded: ${model} · context ${(this.options.chat.loadedRunnerContext ?? running.contextLength).toLocaleString("en-US")}.`, "info");
      this.scheduleRender();
      const selected = await this.choosePromptContext(this.contextCapacity, signal);
      if (selected === null || signal.aborted) throw new Error("Context selection cancelled.");
      this.contextReadyModel = model;
    } finally {
      this.loadingText = null;
      this.scheduleRender();
    }
  }

  private async choosePromptContext(capacity: ContextCapacity, signal: AbortSignal): Promise<number | null> {
    if (signal.aborted) return null;
    return new Promise<number | null>((resolve, reject) => {
      let settled = false;
      const finish = (value: number | null, error?: unknown): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        this.contextSelection = null;
        if (error) reject(error); else resolve(value);
      };
      const onAbort = (): void => {
        if (this.pickerKind === "context") { this.picker = null; this.pickerKind = null; }
        // Applying a context must finish its rollback/daemon restoration before
        // the original message is marked cancelled or another one can start.
        if (!this.changingContext) finish(null);
        this.scheduleRender();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.contextSelection = { finish, signal };
      void this.openContextPicker(capacity, true).catch((error) => finish(null, error));
    });
  }

  private updateContextPickerFooter(): void {
    if (!this.picker || this.pickerKind !== "context") return;
    const selected = Number(this.picker.items[this.picker.index]?.value);
    const physical = this.options.chat.loadedRunnerContext ?? this.runningSnapshot?.contextLength;
    const needsRestart = physical !== undefined && physical !== null && Number.isFinite(selected) &&
      (selected !== physical || this.options.chat.loadedRunnerContext === null || this.runnerRecoveryRequired);
    this.picker.options.footer = needsRestart
      ? `${this.options.chat.engineName} restart required · enter apply · esc cancel`
      : "enter select · esc close · ↑↓ move";
  }

  private async readMemoryStatus(): Promise<HardwareMemoryStatus | null> {
    try { return await (this.options.runtime?.memoryStatus?.() ?? Promise.resolve(null)); }
    catch { return null; }
  }

  private async resetRunnerMemory(signal?: AbortSignal): Promise<boolean> {
    const before = await this.readMemoryStatus();
    const existing = await this.options.chat.getRunningModel(signal) ?? this.runningSnapshot;
    try {
      const released = await this.options.chat.unloadCurrentModel(signal);
      if (released) await this.options.runtime?.waitForMemoryRelease?.(before, released.sizeVramBytes, signal);
      this.runningSnapshot = null;
      return false;
    } catch (error) {
      if (signal?.aborted) throw error;
      if (!this.options.runtime?.restartServer) throw error;
      this.transcript.notice(`Runner release failed; restarting the verified local ${this.options.chat.engineName} server.`, "warn");
      await this.options.runtime.restartServer(signal);
      this.options.chat.clearLoadedRunner();
      await this.options.runtime.waitForMemoryRelease(before, existing?.sizeVramBytes ?? 0, signal);
      this.runningSnapshot = null;
      return true;
    }
  }

  private applyContextValue(tokens: number): Promise<void> {
    if (this.contextChange) return Promise.reject(new Error("An engine context restart is already running."));
    const task = this.performContextChange(tokens);
    this.contextChange = task;
    return task.finally(() => { if (this.contextChange === task) this.contextChange = null; });
  }

  private async performContextChange(tokens: number): Promise<void> {
    if (this.changingContext) throw new Error("An engine context restart is already running.");
    const selection = this.contextSelection;
    const ownedController = selection ? null : new AbortController();
    this.contextRestartController = ownedController;
    const signal = selection?.signal ?? ownedController!.signal;
    const previous = this.options.chat.contextLimit;
    this.changingContext = true;
    let applied = tokens;
    try {
      const runningNow = await this.options.chat.getRunningModel(signal).catch(() => null);
      const loadedNow = this.options.chat.loadedRunnerContext;
      const matchesRunning = Boolean(runningNow) && runningNow!.contextLength === tokens &&
        (loadedNow === tokens || loadedNow === null);
      if (tokens === previous && !this.runnerRecoveryRequired && (!runningNow || matchesRunning)) {
        // Picking the size that is already loaded is a no-op: no unload, no
        // reload, and the live token counters stay intact. Adopt an externally
        // started runner once so later checks know its physical context.
        if (runningNow && loadedNow === null) {
          const adopted = await this.options.chat.loadCurrentModel(signal, tokens);
          if (adopted) this.runningSnapshot = adopted;
        }
        if (runningNow) {
          this.contextReadyModel = this.options.chat.currentModel;
          this.transcript.notice(`${this.options.chat.engineName} already runs ${tokens.toLocaleString("en-US")} tokens; no restart.`, "info");
        }
        selection?.finish(tokens);
        return;
      }

      await this.options.chat.setContextSize(tokens, { duringSetup: Boolean(selection) });
      const current = await this.options.chat.getRunningModel(signal);
      const loaded = this.options.chat.loadedRunnerContext;
      const reuse = current && !this.runnerRecoveryRequired &&
        (loaded === tokens || (loaded === null && current.contextLength === tokens)) && current.contextLength >= tokens;
      if (!reuse && (current || selection || this.options.chat.loadedRunnerInfo)) {
        const model = this.options.chat.currentModel ?? this.options.config.model;
        this.loadingText = current ? `Restarting ${this.options.chat.engineName} · ${model}…` : `Loading model ${model}…`;
        this.transcript.notice(this.loadingText, "info");
        this.scheduleRender();
        let forced = current ? await this.resetRunnerMemory(signal) : false;
        const beforeAllocation = await this.readMemoryStatus();
        try {
          const result = await this.loadModelWithFallback(signal, model, tokens);
          applied = result.tokens;
          this.runningSnapshot = result.running;
        } catch (error) {
          if (signal.aborted || forced || !/out.of.memory|CUDA|failed.*process|server startup/i.test(errorMessage(error)) || !this.options.runtime?.restartServer) throw error;
          forced = true;
          this.transcript.notice(`Restarting ${this.options.chat.engineName} server once after runner startup failure.`, "warn");
          await this.options.runtime.restartServer(signal);
          const baselineFree = beforeAllocation?.gpus.reduce((sum, gpu) => sum + gpu.freeBytes, 0);
          await this.options.runtime.waitForMemoryRelease(beforeAllocation, 0, signal,
            baselineFree === undefined ? undefined : Math.max(0, baselineFree - 256 * 1024 ** 2));
          this.options.chat.clearLoadedRunner();
          const result = await this.loadModelWithFallback(signal, model, tokens);
          applied = result.tokens;
          this.runningSnapshot = result.running;
        }
        this.transcript.notice(`${this.options.chat.engineName} ${forced ? "server restarted" : "runner ready"} · ${applied.toLocaleString("en-US")} tokens.`, "info");
      }
      if (this.options.chat.loadedRunnerContext !== null && this.options.chat.loadedRunnerContext !== applied) {
        throw new Error(`${this.options.chat.engineName} reported ${this.options.chat.loadedRunnerContext.toLocaleString("en-US")} loaded tokens instead of ${applied.toLocaleString("en-US")}. The selected context was not applied.`);
      }
      if (this.options.chat.loadedRunnerInfo) {
        this.runningSnapshot = this.options.chat.loadedRunnerInfo;
        this.contextCapacity = calculateContextCapacity({
          details: await this.options.chat.getModelDetails(),
          running: this.runningSnapshot,
          hardware: await this.readMemoryStatus(),
          parallel: this.parallel?.value,
          requestedContext: applied,
          forceCpu: this.options.chat.cpuOnly,
        });
      }
      if (signal.aborted) throw new Error("Engine context change cancelled.");
      await this.saveModelPreference();
      this.runnerRecoveryRequired = false;
      if (this.options.chat.loadedRunnerContext === applied) this.contextReadyModel = this.options.chat.currentModel;
      selection?.finish(applied);
    } catch (error) {
      this.contextReadyModel = null;
      this.runnerRecoveryRequired = true;
      try { await this.options.chat.setContextSize(previous, { duringSetup: Boolean(selection) }); } catch { /* Preserve the original error. */ }
      selection?.finish(null, error);
      throw error;
    } finally {
      this.changingContext = false;
      if (this.contextRestartController === ownedController) this.contextRestartController = null;
      this.loadingText = null;
      this.scheduleRender();
    }
  }

  private async checkParallel(openPicker = true): Promise<void> {
    if (!this.options.runtime) return;
    this.parallel = await this.options.runtime.parallelStatus();
    if (this.parallel.value !== null && this.parallel.value !== 1 && this.parallel.local) {
      if (openPicker && !this.picker && !this.approval && !this.generating) await this.openParallelPicker();
      else this.transcript.notice(`${this.options.chat.engineName} parallel=${this.parallel.value}. Recommend 1 for a single agent; use /parallel.`, "warn");
    }
    this.scheduleRender();
  }

  private async openParallelPicker(): Promise<void> {
    if (!this.options.runtime) {
      this.transcript.notice("Parallel configuration is available for managed local startup only.", "info");
      return;
    }
    this.parallel = await this.options.runtime.parallelStatus();
    this.picker = new Picker({
      title: `${this.options.chat.engineName} parallel: ${this.parallel.value ?? "unknown"}`,
      message: `One agent needs one parallel slot. Extra slots multiply KV-cache. Detected via ${this.parallel.source}. ${this.options.chat.currentProvider === "llama.cpp" ? "Applies to the next managed model load." : "Existing Ollama needs a restart after saving."}`,
      showFilter: false,
      selected: "keep",
      items: [
        { value: "set-one", label: "Set parallel = 1", detail: this.options.chat.currentProvider === "llama.cpp" ? "TinyCode-managed startup only" : process.platform === "win32" ? "save Windows user environment" : "use for TinyCode-managed startup", disabled: !this.parallel.canSet, tone: "success" },
        { value: "keep", label: "Keep current setting", detail: "no changes", tone: "muted" },
      ],
      messageStyle: "info",
    });
    this.pickerKind = "parallel";
    this.scheduleRender();
  }

  private async openModelPicker(): Promise<void> {
    this.loadingText = "loading model catalogs…";
    this.scheduleRender();
    try {
      const groups = await this.options.chat.listProviderModels();
      const items: PickerItem[] = [];
      for (const group of groups) {
        const count = group.models.length;
        items.push({
          value: `__heading__${group.provider.id}`,
          label: group.provider.name,
          detail: group.error ? "unavailable" : `${count} ${count === 1 ? "model" : "models"}`,
          heading: true,
          disabled: true,
          tone: group.error ? "danger" : "accent",
        });
        if (group.error) {
          items.push({ value: `__error__${group.provider.id}`, label: "Unavailable", detail: group.error, disabled: true, nested: true, tone: "danger" });
        } else if (group.models.length === 0) {
          items.push({ value: `__empty__${group.provider.id}`, label: "No models found", detail: group.provider.id === "llama.cpp" ? "add a GGUF to ~/.tinytcode/models or llama.modelDirs" : "pull a model with Ollama", disabled: true, nested: true, tone: "muted" });
        } else for (const model of group.models) {
          const current = group.provider.id === this.options.chat.currentProvider && model.id === this.options.chat.currentModel;
          const details = [current ? "current" : undefined, model.parameterSize, model.quantization, model.sizeBytes ? formatBytes(model.sizeBytes) : undefined].filter((value): value is string => Boolean(value));
          items.push({ value: JSON.stringify([group.provider.id, model.id]), label: model.name, detail: details.join(" · "), nested: true, tone: current ? "success" : "info" });
        }
      }
      this.pickerKind = "model";
      this.picker = new Picker({
        title: "Models",
        placeholder: "Filter models…",
        items,
        selected: JSON.stringify([this.options.chat.currentProvider, this.options.chat.currentModel]),
        message: "Models are grouped by engine. Selecting one also switches its engine; weights load only after your prompt.",
        messageStyle: "info",
      });
    } catch (error) {
      this.transcript.notice(errorMessage(error), "error");
    } finally {
      this.loadingText = null;
      this.scheduleRender();
    }
  }

  private async openRecommendationPicker(): Promise<void> {
    this.loadingText = "checking hardware recommendations…";
    this.scheduleRender();
    try {
      const recommendations = recommendModels(await this.readMemoryStatus());
      this.recommendations.clear();
      for (const model of recommendations) this.recommendations.set(model.id, model);
      if (!recommendations.length) {
        this.transcript.notice("No seed-catalog model fits the available RAM/VRAM estimate with at least 32k context.", "warn");
        return;
      }
      const labels: Record<ModelRecommendation["placement"], string> = { vram: "VRAM only", hybrid: "Hybrid RAM / VRAM", ram: "RAM only" };
      const items: PickerItem[] = [];
      for (const placement of ["vram", "hybrid", "ram"] as const) {
        const models = recommendations.filter((model) => model.placement === placement);
        if (!models.length) continue;
        const placementTone = placement === "vram" ? "success" as const : placement === "hybrid" ? "warning" as const : "danger" as const;
        items.push({ value: `__heading__${placement}`, label: labels[placement], detail: `${models.length} ${models.length === 1 ? "model" : "models"}`, heading: true, disabled: true, tone: placementTone });
        for (const model of models) {
          const parameters = model.activeParametersB ? `${model.totalParametersB}B A${model.activeParametersB}B` : `${model.totalParametersB}B`;
          const inference = model.recommendedInference === "standard" ? "Standard" : inferenceProfileLabel(model.recommendedInference);
          items.push({ value: model.id, label: model.name, detail: `${parameters} · ${model.quantization} · ctx ${model.recommendedContext.toLocaleString("en-US")} · ~${formatBytes(model.estimatedMemoryBytes)} · ${inference}`, nested: true, tone: placementTone });
        }
      }
      this.pickerKind = "recommendation";
      this.picker = new Picker({
        title: "Recommended models",
        message: "Curated for 8B+ coding agents. Estimates reserve OS/compute memory and F16 KV for at least 32k context. Selecting a model asks approval before its install command.",
        messageStyle: "info",
        placeholder: "Filter recommendations…",
        items,
      });
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
        detail: `${session.tabClosedAt ? "closed tab · " : ""}${session.id} · ${session.messageCount} msgs · ${relativeTime(session.updatedAt)}`,
        tone: session.tabClosedAt ? "warning" : session.id === this.options.chat.current?.meta.id ? "success" : "accent",
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

  private upsertSessionTab(meta: SessionMeta): void {
    const target = path.resolve(this.options.cwd);
    const sessionCwd = path.resolve(meta.cwd);
    const same = process.platform === "win32" ? target.toLowerCase() === sessionCwd.toLowerCase() : target === sessionCwd;
    if (!same) return;
    if (meta.tabClosedAt) {
      this.sessionTabs = this.sessionTabs.filter((session) => session.id !== meta.id);
      return;
    }
    const copy = { ...meta };
    const index = this.sessionTabs.findIndex((session) => session.id === meta.id);
    if (index >= 0) this.sessionTabs[index] = copy;
    else this.sessionTabs.push(copy);
    this.sessionTabs.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private async refreshSessionTabs(): Promise<void> {
    const current = this.options.chat.current?.meta;
    const sessions = (await this.options.chat.listSessions(this.options.cwd))
      .filter((session) => (!session.tabClosedAt || session.id === current?.id) && (session.messageCount > 0 || session.id === current?.id));
    this.sessionTabs = sessions.map((session) => ({ ...session }));
    if (current && !this.sessionTabs.some((session) => session.id === current.id)) this.sessionTabs.unshift({ ...current });
    this.sessionTabs.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private async switchSessionTab(id: string): Promise<void> {
    if (id === this.options.chat.current?.meta.id) return;
    this.contextRestartController?.abort();
    if (this.options.chat.busy) {
      this.options.chat.abort(true);
      await this.options.chat.waitForIdle();
    }
    await this.contextChange?.catch(() => {});
    await this.options.chat.resume(id);
    this.transcript.reset();
    this.sessionId = id;
    this.scroll = 0;
    this.lastTotalLines = 0;
    this.contextReadyModel = null;
    this.contextCapacity = null;
    this.runningSnapshot = null;
    await this.refreshSessionTabs();
  }

  private async activateSessionTab(hit: { sessionId?: string; close?: boolean; create?: boolean; sessions?: boolean }): Promise<void> {
    try {
      if (hit.create) await this.newSession();
      else if (hit.sessions) await this.openSessionPicker();
      else if (hit.sessionId && hit.close) {
        this.contextRestartController?.abort();
        if (this.options.chat.busy) {
          this.options.chat.abort(true);
          await this.options.chat.waitForIdle();
        }
        await this.contextChange?.catch(() => {});
        await this.options.chat.setSessionTabClosed(hit.sessionId, true);
        if (hit.sessionId === this.options.chat.current?.meta.id) {
          const next = this.sessionTabs.find((session) => session.id !== hit.sessionId);
          if (next) await this.switchSessionTab(next.id);
          else await this.newSession();
        }
        this.transcript.notice("Session tab closed. The saved session remains available in /sessions.", "info");
      } else if (hit.sessionId) await this.switchSessionTab(hit.sessionId);
    } catch (error) {
      this.transcript.notice(errorMessage(error), "error");
    }
    this.scheduleRender();
  }

  private handlePickerKey(key: Key): void {
    const picker = this.picker;
    if (!picker) return;
    const result = picker.handleKey(key);
    if (result.type === "cancel") {
      if (this.contextSelection && this.pickerKind === "context") {
        this.contextSelection.finish(null);
        this.options.chat.abort();
      }
      this.picker = null;
      this.pickerKind = null;
      this.continueModelSetup = false;
      this.pendingInferenceProfile = null;
      this.scheduleRender();
      return;
    }
    if (result.type === "update") {
      this.updateContextPickerFooter();
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
        let provider = this.options.chat.currentProvider;
        let model = item.value;
        try {
          const decoded = JSON.parse(item.value) as unknown;
          if (Array.isArray(decoded) && decoded.length === 2 && decoded.every((value) => typeof value === "string")) [provider, model] = decoded as [string, string];
        } catch { /* Direct /model and old picker callers use a plain model id. */ }
        if (provider !== this.options.chat.currentProvider) await this.setProvider(provider, false);
        if (model !== this.options.chat.currentModel) await this.setModel(model);
        else await this.openThinkingPicker(true);
      } else if (kind === "recommendation") {
        const recommendation = this.recommendations.get(item.value);
        if (!recommendation) throw new Error("Recommendation is no longer available; reopen /recommend.");
        const result = await this.options.chat.runApprovedCommand(recommendation.installCommand, `Install ${recommendation.name}`);
        this.transcript.notice(result.output.slice(0, 6_000), result.ok ? "info" : "error");
        if (result.ok) this.transcript.notice("Installation command completed. Open /models to select the model after its engine discovers it.", "info");
      } else if (kind === "provider") {
        await this.setProvider(item.value);
      } else if (kind === "thinking") {
        const continueSetup = this.continueModelSetup;
        await this.options.chat.setThinking(item.value);
        await this.saveModelPreference();
        this.transcript.notice(`Thinking: ${item.label}.`, "info");
        if (continueSetup) await this.openInferencePicker(true);
        else this.continueModelSetup = false;
      } else if (kind === "inference") {
        if (!isInferenceProfile(item.value)) throw new Error(`Unknown inference profile: ${item.value}`);
        if (isMtpProfile(item.value) && !this.options.chat.currentInferenceDraftModel) await this.openDraftModelPicker(item.value);
        else await this.applyInferenceProfile(item.value);
      } else if (kind === "draft-model") {
        const profile = this.pendingInferenceProfile;
        if (!profile) throw new Error("MTP profile selection expired; reopen /inference.");
        if (item.value === "__custom__") {
          this.editor.setText(`/inference ${profile} `);
          this.pendingInferenceProfile = null;
          this.continueModelSetup = false;
        } else await this.applyInferenceProfile(profile, item.value);
      } else if (kind === "context") {
        if (item.value === "custom") this.editor.setText("/context ");
        else {
          await this.applyContextValue(Number(item.value));
        }
      } else if (kind === "parallel" && item.value === "set-one" && this.options.runtime) {
        this.parallel = await this.options.runtime.setParallelOne();
        if (this.options.chat.currentProvider === "llama.cpp") {
          this.options.persistedConfig.llama.parallel = 1; this.options.config.llama.parallel = 1;
          this.options.chat.clearLoadedRunner(); this.contextReadyModel = null;
        } else {
          this.options.persistedConfig.ollama.parallel = 1; this.options.config.ollama.parallel = 1;
        }
        await this.persistConfig();
        this.transcript.notice(this.parallel.restartRequired
          ? "Saved parallel=1. Completely restart the existing Ollama application/server to apply it; TinyCode did not stop your server."
          : `${this.options.chat.engineName} parallel=1 saved for managed startup.`, "info");
      } else if (kind === "session") {
        await this.switchSessionTab(item.value);
        this.transcript.notice(`Resumed ${item.value}.`, "info");
      }
    } catch (error) {
      this.transcript.notice(errorMessage(error), "error");
    }
    this.scheduleRender();
  }

  private async newSession(): Promise<void> {
    this.contextRestartController?.abort();
    if (this.options.chat.busy) {
      this.options.chat.abort(true);
      await this.options.chat.waitForIdle();
    }
    await this.contextChange?.catch(() => {});
    await this.options.chat.createSession();
    this.transcript.reset();
    this.sessionId = null;
    this.scroll = 0;
    this.lastTotalLines = 0;
    this.transcript.notice("New session started.", "info");
    this.contextReadyModel = null;
    this.contextCapacity = null;
    this.runningSnapshot = null;
    await this.refreshSessionTabs();
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
        `${lines.length} tools (○ automatic · ◆ requires approval)`,
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
        `Engine    ${this.options.chat.engineName}`,
        `Model     ${session.meta.model}`,
        `Cwd       ${session.meta.cwd}`,
        `Messages  ${session.messages.length}`,
        `Goal      ${session.meta.goal ? `${singleLine(session.meta.goal.text)} · ${session.meta.goal.continuations} continuations` : "off"}`,
        `Context   ${this.options.chat.contextLimit.toLocaleString("en-US")} tokens · full history until compaction`,
        `Compact pressure ${(this.options.chat.contextPressure * 100).toFixed(0)}% · trigger ${(this.options.config.compaction.threshold * 100).toFixed(0)}%`,
        `Tools     ${this.options.chat.toolsEnabled ? `enabled · ${this.options.chat.toolCount}` : "disabled"}${
          this.options.chat.toolsEnabled
            ? ` · approval ${this.options.config.tools.autoApprove ? "auto" : "ask"}`
            : ""
        }`,
        `Profile   ${this.options.chat.currentToolProfile}`,
        `Inference ${inferenceProfileLabel(this.options.chat.currentInferenceProfile)}${this.options.chat.currentInferenceDraftModel && isMtpProfile(this.options.chat.currentInferenceProfile) ? ` · ${path.basename(this.options.chat.currentInferenceDraftModel)}` : ""}`,
        `MCP       ${Object.values(this.options.config.mcp.servers).filter((server) => server.enabled).length} configured`,
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
    this.options.chat.abort(true);
    this.contextRestartController?.abort();
    this.contextSelection?.finish(null);
    this.parser.dispose();
    void this.options.chat.waitForIdle().finally(async () => {
      await this.contextChange?.catch(() => {});
      this.resolveExit?.();
    });
  }

  private cleanup(): void {
    this.exiting = true;
    this.contextSelection?.finish(null);
    this.contextRestartController?.abort();
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
