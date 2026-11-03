import type { Style } from "../util/ansi.js";
import { RESET, displayWidth, sgr, takeWidth } from "../util/ansi.js";

export interface Span {
  text: string;
  style?: Style;
}

export type Line = Span[];

export function textLine(text: string, style?: Style): Line {
  return text ? [{ text, style }] : [];
}

export function spaces(count: number, style?: Style): Line {
  return count > 0 ? [{ text: " ".repeat(count), style }] : [];
}

export function concatLines(...lines: Line[]): Line {
  return lines.flat();
}

export function lineWidth(line: Line): number {
  let width = 0;
  for (const span of line) width += displayWidth(span.text);
  return width;
}

export function fitLine(line: Line, width: number): Line {
  if (width <= 0) return [];
  const out: Line = [];
  let used = 0;
  for (const span of line) {
    if (used >= width) break;
    const text = takeWidth(span.text, width - used);
    if (!text) continue;
    out.push({ ...span, text });
    used += displayWidth(text);
  }
  return out;
}

export function padLine(line: Line, width: number, style?: Style): Line {
  const fitted = fitLine(line, width);
  const remaining = width - lineWidth(fitted);
  return remaining > 0 ? [...fitted, { text: " ".repeat(remaining), style }] : fitted;
}

export function styleLine(line: Line, style: Style): Line {
  return line.map((span) => ({ ...span, style: { ...style, ...span.style } }));
}

export function emitLine(line: Line, width: number): string {
  let out = "";
  let used = 0;
  for (const span of line) {
    if (used >= width) break;
    const text = takeWidth(span.text, width - used);
    if (!text) continue;
    const prefix = sgr(span.style);
    out += prefix ? `${prefix}${text}${RESET}` : text;
    used += displayWidth(text);
  }
  return out;
}
