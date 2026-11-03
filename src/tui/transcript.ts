import type { Message, ToolPart } from "../core/session/types.js";
import { messageVersion, textOf } from "../core/session/types.js";
import type { NoticeLevel } from "../core/types.js";
import { displayWidth, truncateWidth, wrapPlain } from "../util/ansi.js";
import { newNoticeId } from "../util/id.js";
import { sanitizeText, singleLine } from "../util/text.js";
import { clockTime, formatCompactNumber } from "../util/time.js";
import { renderMarkdown } from "./markdown.js";
import type { Palette } from "./theme.js";
import type { Line } from "./types.js";

export interface Notice {
  id: string;
  at: number;
  text: string;
  level: NoticeLevel;
}

interface CacheEntry {
  width: number;
  version: string;
  lines: Line[];
}

function withIndent(line: Line, indent: string): Line {
  return [{ text: indent }, ...line];
}

function truncatedHeaderName(message: Message): string {
  const name = message.role === "user" ? "you" : message.model ? message.model : "assistant";
  return sanitizeText(name);
}

function preview(text: string, width: number, maxLines: number): { lines: string[]; truncated: boolean } {
  const all = wrapPlain(sanitizeText(text), Math.max(8, width));
  return { lines: all.slice(0, maxLines), truncated: all.length > maxLines };
}

function toolStatus(part: ToolPart): { glyph: string; label: string } {
  switch (part.status) {
    case "pending":
      return { glyph: "◌", label: "queued" };
    case "running":
      return { glyph: "◐", label: "running" };
    case "completed":
      return { glyph: "✔", label: "done" };
    case "error":
      return { glyph: "✖", label: "error" };
    case "denied":
      return { glyph: "⊘", label: "denied" };
  }
}

/**
 * Turns session messages into styled lines. Everything is cached per message
 * and rebuilt only while a message is streaming, so long sessions stay cheap.
 * Parts are rendered in order: thinking, answer text and tool calls remain
 * visually separate, like OpenCode.
 */
export class Transcript {
  private messages: Message[] = [];
  private notices: Notice[] = [];
  private readonly cache = new Map<string, CacheEntry>();

  hideBefore = 0;
  showReasoning = true;
  showToolOutput = true;

  constructor(private readonly palette: Palette) {}

  reset(): void {
    this.messages = [];
    this.notices = [];
    this.cache.clear();
    this.hideBefore = 0;
  }

  sync(messages: Message[]): void {
    this.messages = messages;
    const alive = new Set(messages.map((message) => message.id));
    for (const id of this.cache.keys()) {
      if (!alive.has(id)) this.cache.delete(id);
    }
  }

  notice(text: string, level: NoticeLevel = "info"): void {
    this.notices.push({ id: newNoticeId(), at: Date.now(), text, level });
    if (this.notices.length > 80) this.notices.shift();
  }

  clearNotices(): void {
    this.notices = [];
  }

  /** Hide everything that already happened, like a terminal clear that keeps state. */
  clearView(): void {
    this.hideBefore = Date.now();
    this.notices = [];
    this.cache.clear();
  }

  build(width: number): Line[] {
    const entries: Array<{ at: number; order: number; lines: Line[] }> = [];
    let order = 0;

    for (const message of this.messages) {
      if (message.createdAt <= this.hideBefore) continue;
      entries.push({ at: message.createdAt, order: order++, lines: this.messageLines(message, width) });
    }
    for (const notice of this.notices) {
      if (notice.at <= this.hideBefore) continue;
      entries.push({ at: notice.at, order: order++, lines: this.noticeLines(notice, width) });
    }

    entries.sort((a, b) => a.at - b.at || a.order - b.order);
    return entries.flatMap((entry) => entry.lines);
  }

  private messageLines(message: Message, width: number): Line[] {
    const version =
      messageVersion(message) +
      `|r${this.showReasoning ? 1 : 0}|t${this.showToolOutput ? 1 : 0}`;
    const cached = this.cache.get(message.id);
    if (cached && cached.width === width && cached.version === version) return cached.lines;

    const lines = this.renderMessage(message, Math.max(16, width));
    this.cache.set(message.id, { width, version, lines });
    return lines;
  }

  private renderReasoning(text: string, width: number): Line[] {
    if (!this.showReasoning) {
      return [[{ text: "  ◇ thinking (hidden)", style: { fg: this.palette.faint, dim: true } }]];
    }
    const lines: Line[] = [
      [{ text: "  ◇ thinking", style: { fg: this.palette.reasoning, bold: true } }],
    ];
    for (const line of renderMarkdown(text, Math.max(8, width - 4), this.palette)) {
      lines.push([
        { text: "  ┊ ", style: { fg: this.palette.faint } },
        ...line.map((span) => ({
          ...span,
          style: { fg: this.palette.reasoning, dim: true, ...span.style },
        })),
      ]);
    }
    return lines;
  }

  private renderTool(part: ToolPart, width: number): Line[] {
    const palette = this.palette;
    const { glyph, label } = toolStatus(part);
    const color =
      part.status === "error"
        ? palette.error
        : part.status === "denied"
          ? palette.warn
          : part.status === "completed"
            ? palette.success
            : palette.accent;

    const lines: Line[] = [
      [
        { text: "  " },
        { text: `${glyph} ${part.tool}`, style: { fg: color, bold: true } },
        { text: `  ${label}`, style: { fg: palette.faint } },
      ],
    ];

    if (part.title) {
      lines.push([
        { text: "    " },
        {
          text: truncateWidth(sanitizeText(singleLine(part.title)), Math.max(10, width - 4)),
          style: { fg: palette.muted },
        },
      ]);
    }

    const errorLike = part.status === "error" || part.status === "denied";
    const body = errorLike ? part.error ?? part.output : part.output;
    if (this.showToolOutput && body?.trim()) {
      const previewBody = preview(body, Math.max(8, width - 6), 8);
      const previewColor = errorLike ? color : palette.faint;
      for (const text of previewBody.lines) {
        lines.push([
          { text: "    │ ", style: { fg: palette.faint } },
          { text, style: { fg: previewColor } },
        ]);
      }
      if (previewBody.truncated) {
        lines.push([{ text: "    │ …", style: { fg: palette.faint } }]);
      }
    } else if (part.status === "pending" || part.status === "running") {
      lines.push([{ text: "    │ …", style: { fg: palette.faint } }]);
    }

    return lines;
  }

  private renderError(error: string, width: number): Line[] {
    const lines: Line[] = [];
    for (const [index, raw] of sanitizeText(error).split("\n").entries()) {
      const wrapped = wrapPlain(raw, Math.max(10, width - 4));
      for (const [wrappedIndex, part] of wrapped.entries()) {
        if (index === 0 && wrappedIndex === 0) {
          lines.push([
            { text: "  ✖ ", style: { fg: this.palette.error } },
            { text: part, style: { fg: this.palette.error } },
          ]);
        } else {
          lines.push([{ text: "    " }, { text: part, style: { fg: this.palette.error } }]);
        }
      }
    }
    return lines;
  }

  private renderMessage(message: Message, width: number): Line[] {
    const palette = this.palette;
    const roleColor = message.role === "user" ? palette.user : palette.assistant;
    const timestamp = clockTime(message.createdAt);
    const nameWidth = Math.max(4, width - 2 - 2 - displayWidth(timestamp));

    const lines: Line[] = [
      [
        { text: "▌ ", style: { fg: roleColor } },
        { text: truncateWidth(truncatedHeaderName(message), nameWidth), style: { fg: roleColor, bold: true } },
        { text: `  ${timestamp}`, style: { fg: palette.faint } },
      ],
    ];

    const bodyWidth = Math.max(10, width - 2);
    const blocks: Line[][] = [];

    for (const part of message.parts) {
      if (part.type === "reasoning") {
        if (part.text.trim()) blocks.push(this.renderReasoning(part.text, bodyWidth));
      } else if (part.type === "text") {
        if (part.text.trim()) {
          blocks.push(renderMarkdown(part.text, bodyWidth, palette).map((line) => withIndent(line, "  ")));
        }
      } else if (part.type === "tool") {
        blocks.push(this.renderTool(part, bodyWidth));
      }
    }

    if (blocks.length === 0 && message.role === "assistant" && !message.error && !message.aborted) {
      blocks.push([[{ text: "  …", style: { fg: palette.faint } }]]);
    }
    if (message.error) blocks.push(this.renderError(message.error, bodyWidth));

    for (const [index, block] of blocks.entries()) {
      if (index > 0) lines.push([]);
      lines.push(...block);
    }

    if (message.aborted) {
      if (blocks.length > 0) lines.push([]);
      lines.push([{ text: "  (aborted)", style: { fg: palette.faint, dim: true } }]);
    }
    if (message.outcome === "blocked") lines.push([{ text: "  blocked · task not completed", style: { fg: palette.warn } }]);

    if (message.usage) {
      const parts = [
        `${formatCompactNumber(message.usage.promptTokens)} in`,
        `${formatCompactNumber(message.usage.completionTokens)} out`,
      ];
      if (message.usage.tokensPerSecond) parts.push(`${message.usage.tokensPerSecond.toFixed(1)} tok/s`);
      lines.push([{ text: truncateWidth(`  ${parts.join(" · ")}`, width), style: { fg: palette.faint } }]);
    }

    lines.push([]);
    return lines;
  }

  private noticeLines(notice: Notice, width: number): Line[] {
    const color =
      notice.level === "error" ? this.palette.error : notice.level === "warn" ? this.palette.warn : this.palette.muted;
    const glyph = notice.level === "error" ? "✖" : notice.level === "warn" ? "!" : "·";
    const body = sanitizeText(notice.text);
    const wrapped = wrapPlain(body, Math.max(10, width - 4));
    if (wrapped.length === 0) wrapped.push("");
    return wrapped.map((text, index) =>
      index === 0
        ? [
            { text: `  ${glyph} `, style: { fg: color } },
            { text, style: { fg: color } },
          ]
        : [{ text: "    " }, { text, style: { fg: color } }],
    );
  }
}

/** Header text used by the picker when a title is too wide. */
export function shortTitle(title: string, width: number): string {
  return truncateWidth(singleLine(sanitizeText(title)), Math.max(1, width));
}
