import type { Palette } from "./theme.js";
import type { Line, Span } from "./types.js";
import type { Style } from "../util/ansi.js";
import { displayWidth, takeWidth } from "../util/ansi.js";
import { sanitizeText } from "../util/text.js";

const HORIZONTAL_RULE = /^\s*([-*_])\s*(?:\1\s*){2,}$/;
const INLINE_PATTERN = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*\n]+\*|_[^_\n]+_|\[[^\]]+\]\([^)]+\))/g;

function sameStyle(a?: Style, b?: Style): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.fg === b.fg &&
    a.bg === b.bg &&
    Boolean(a.bold) === Boolean(b.bold) &&
    Boolean(a.dim) === Boolean(b.dim) &&
    Boolean(a.italic) === Boolean(b.italic) &&
    Boolean(a.underline) === Boolean(b.underline) &&
    Boolean(a.reverse) === Boolean(b.reverse)
  );
}

/**
 * Wrap styled spans at a display width. Breaks on whitespace when possible
 * and hard-splits very long words (URLs, code) so layout never overflows.
 */
export function wrapSpans(spans: Span[], width: number): Line[] {
  const max = Math.max(1, width);
  const lines: Line[] = [];
  let current: Line = [];
  let currentWidth = 0;
  let pendingSpace = false;

  const pushSpan = (text: string, style?: Style): void => {
    if (!text) return;
    const last = current[current.length - 1];
    if (last && sameStyle(last.style, style)) last.text += text;
    else current.push({ text, style });
  };

  const newline = (): void => {
    lines.push(current);
    current = [];
    currentWidth = 0;
    pendingSpace = false;
  };

  for (const span of spans) {
    const tokens = span.text.split(/(\s+)/);
    for (const token of tokens) {
      if (!token) continue;

      if (/^\s+$/.test(token)) {
        if (current.length > 0) pendingSpace = true;
        continue;
      }

      const spaceWidth = pendingSpace ? 1 : 0;
      const tokenWidth = displayWidth(token);

      if (currentWidth + spaceWidth + tokenWidth > max && current.length > 0) {
        newline();
      } else if (pendingSpace) {
        pushSpan(" ", span.style);
        currentWidth += 1;
        pendingSpace = false;
      }

      if (tokenWidth > max) {
        let rest = token;
        while (displayWidth(rest) > max) {
          const head = takeWidth(rest, max);
          if (!head) break;
          if (current.length > 0) newline();
          pushSpan(head, span.style);
          currentWidth = displayWidth(head);
          newline();
          rest = rest.slice(head.length);
        }
        if (rest) {
          pushSpan(rest, span.style);
          currentWidth += displayWidth(rest);
        }
      } else {
        pushSpan(token, span.style);
        currentWidth += tokenWidth;
      }
    }
  }

  if (current.length > 0 || lines.length === 0) lines.push(current);
  return lines;
}

function parseInline(text: string, palette: Palette): Span[] {
  const spans: Span[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(INLINE_PATTERN)) {
    const index = match.index ?? 0;
    if (index > lastIndex) spans.push({ text: text.slice(lastIndex, index) });
    const token = match[0]!;

    if (token.startsWith("`")) {
      spans.push({ text: token.slice(1, -1), style: { fg: palette.code } });
    } else if (token.startsWith("**") || token.startsWith("__")) {
      spans.push({ text: token.slice(2, -2), style: { bold: true } });
    } else if (token.startsWith("*") || token.startsWith("_")) {
      spans.push({ text: token.slice(1, -1), style: { italic: true } });
    } else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      if (link) {
        const [, label, url] = link;
        spans.push({ text: label!, style: { fg: palette.accent, underline: true } });
        if (url && url !== label) spans.push({ text: ` (${url})`, style: { fg: palette.faint } });
      } else {
        spans.push({ text: token });
      }
    }
    lastIndex = index + token.length;
  }
  if (lastIndex < text.length) spans.push({ text: text.slice(lastIndex) });
  return spans.length > 0 ? spans : [{ text }];
}

function prefixed(
  prefix: string,
  content: Span[],
  width: number,
  prefixStyle?: Style,
  baseStyle?: Style,
): Line[] {
  const prefixWidth = displayWidth(prefix);
  let body = wrapSpans(content, Math.max(1, width - prefixWidth));
  if (baseStyle) {
    body = body.map((line) => line.map((span) => ({ ...span, style: { ...baseStyle, ...span.style } })));
  }
  if (body.length === 0) return [[{ text: prefix, style: prefixStyle }]];
  return body.map((line, index) =>
    index === 0
      ? [{ text: prefix, style: prefixStyle }, ...line]
      : [{ text: " ".repeat(prefixWidth) }, ...line],
  );
}

function hardWrap(text: string, width: number): string[] {
  const max = Math.max(1, width);
  if (text === "") return [""];
  const out: string[] = [];
  let rest = text;
  while (displayWidth(rest) > max) {
    const head = takeWidth(rest, max);
    if (!head) break;
    out.push(head);
    rest = rest.slice(head.length);
  }
  out.push(rest);
  return out;
}

function isBlockStart(line: string): boolean {
  return (
    /^\s*```/.test(line) ||
    /^(#{1,6})\s+/.test(line) ||
    /^\s*[-*+]\s+/.test(line) ||
    /^\s*\d+[.)]\s+/.test(line) ||
    /^\s*>\s?/.test(line) ||
    HORIZONTAL_RULE.test(line)
  );
}

/**
 * Small Markdown renderer aimed at model output: fenced code, headings, lists,
 * quotes, emphasis, inline code and links. Deliberately not a full parser.
 */
export function renderMarkdown(rawText: string, width: number, palette: Palette): Line[] {
  const normalized = sanitizeText(rawText).replace(/\r\n?/g, "\n");
  const max = Math.max(8, width);
  const source = normalized.split("\n");
  const lines: Line[] = [];
  let inCode = false;
  let codeLines: string[] = [];

  const blank = (): void => {
    if (lines.length > 0 && lines[lines.length - 1]!.length > 0) lines.push([]);
  };

  const flushCode = (): void => {
    for (const rawCode of codeLines) {
      for (const chunk of hardWrap(rawCode.replace(/\t/g, "  "), Math.max(1, max - 4))) {
        lines.push([
          { text: "  │ ", style: { fg: palette.faint } },
          { text: chunk || " ", style: { fg: palette.code } },
        ]);
      }
    }
    codeLines = [];
    blank();
  };

  for (let index = 0; index < source.length; index++) {
    const raw = source[index]!;

    if (/^\s*```/.test(raw)) {
      if (inCode) {
        inCode = false;
        flushCode();
      } else {
        blank();
        inCode = true;
      }
      continue;
    }

    if (inCode) {
      codeLines.push(raw);
      continue;
    }

    if (!raw.trim()) {
      blank();
      continue;
    }

    if (HORIZONTAL_RULE.test(raw)) {
      blank();
      lines.push([{ text: "─".repeat(max), style: { fg: palette.border } }]);
      blank();
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (heading) {
      blank();
      const content = parseInline(heading[2]!, palette).map((span) => ({
        ...span,
        style: { fg: palette.accent, bold: true, ...span.style },
      }));
      lines.push(...wrapSpans(content, max));
      blank();
      continue;
    }

    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(raw);
    if (bullet) {
      const indent = Math.min(bullet[1]!.length, 6);
      const prefix = `${" ".repeat(indent)}• `;
      lines.push(...prefixed(prefix, parseInline(bullet[2]!, palette), max, { fg: palette.faint }));
      continue;
    }

    const numbered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(raw);
    if (numbered) {
      const indent = Math.min(numbered[1]!.length, 6);
      const prefix = `${" ".repeat(indent)}${numbered[2]}. `;
      lines.push(...prefixed(prefix, parseInline(numbered[3]!, palette), max, { fg: palette.faint }));
      continue;
    }

    const quote = /^\s*>\s?(.*)$/.exec(raw);
    if (quote) {
      lines.push(
        ...prefixed(
          "  │ ",
          parseInline(quote[1]!, palette),
          max,
          { fg: palette.faint },
          { fg: palette.muted, italic: true },
        ),
      );
      continue;
    }

    const paragraph: string[] = [raw.trim()];
    while (index + 1 < source.length) {
      const next = source[index + 1]!;
      if (!next.trim() || isBlockStart(next)) break;
      index++;
      paragraph.push(next.trim());
    }
    lines.push(...wrapSpans(parseInline(paragraph.join(" "), palette), max));
  }

  if (inCode) flushCode();

  while (lines.length > 0 && lines[0]!.length === 0) lines.shift();
  while (lines.length > 0 && lines[lines.length - 1]!.length === 0) lines.pop();
  return lines;
}
