export interface Style {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  reverse?: boolean;
}

export const RESET = "\x1b[0m";

function colorSequence(color: string, layer: 38 | 48): string {
  const hex = /^#([0-9a-fA-F]{6})$/.exec(color);
  if (hex) {
    const value = parseInt(hex[1]!, 16);
    const r = (value >> 16) & 0xff;
    const g = (value >> 8) & 0xff;
    const b = value & 0xff;
    return `\x1b[${layer};2;${r};${g};${b}m`;
  }
  if (/^\d{1,3}$/.test(color)) {
    return `\x1b[${layer};5;${color}m`;
  }
  return "";
}

export function sgr(style?: Style): string {
  if (!style) return "";
  let out = "";
  if (style.bold) out += "\x1b[1m";
  if (style.dim) out += "\x1b[2m";
  if (style.italic) out += "\x1b[3m";
  if (style.underline) out += "\x1b[4m";
  if (style.reverse) out += "\x1b[7m";
  if (style.fg) out += colorSequence(style.fg, 38);
  if (style.bg) out += colorSequence(style.bg, 48);
  return out;
}

export function codePointWidth(cp: number): number {
  if (cp === 0) return 0;
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  // Combining marks and joiners.
  if (cp >= 0x0300 && cp <= 0x036f) return 0;
  if (cp >= 0x1ab0 && cp <= 0x1aff) return 0;
  if (cp >= 0x1dc0 && cp <= 0x1dff) return 0;
  if (cp >= 0x20d0 && cp <= 0x20ff) return 0;
  if (cp >= 0xfe00 && cp <= 0xfe0f) return 0;
  if (cp >= 0xfe20 && cp <= 0xfe2f) return 0;
  if (cp === 0x200d) return 0;
  // East Asian wide / fullwidth and emoji.
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f000 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += codePointWidth(ch.codePointAt(0) ?? 0);
  return width;
}

export function takeWidth(text: string, max: number): string {
  if (max <= 0) return "";
  let out = "";
  let width = 0;
  for (const ch of text) {
    const w = codePointWidth(ch.codePointAt(0) ?? 0);
    if (width + w > max) break;
    out += ch;
    width += w;
  }
  return out;
}

export function truncateWidth(text: string, max: number, ellipsis = "…"): string {
  if (max <= 0) return "";
  if (displayWidth(text) <= max) return text;
  const ellipsisWidth = displayWidth(ellipsis);
  if (max <= ellipsisWidth) return takeWidth(ellipsis, max);
  return takeWidth(text, max - ellipsisWidth) + ellipsis;
}

export function padEndWidth(text: string, width: number): string {
  const current = displayWidth(text);
  return current >= width ? text : text + " ".repeat(width - current);
}

/** Word-wrap plain text, preserving explicit newlines and hard-breaking long words. */
export function wrapPlain(text: string, width: number): string[] {
  const max = Math.max(1, width);
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    if (raw === "") {
      out.push("");
      continue;
    }
    let line = "";
    let lineWidth = 0;
    for (const word of raw.split(/\s+/).filter(Boolean)) {
      const wordWidth = displayWidth(word);
      const space = line ? 1 : 0;
      if (line && lineWidth + space + wordWidth > max) {
        out.push(line);
        line = word;
        lineWidth = wordWidth;
      } else {
        line += (line ? " " : "") + word;
        lineWidth += space + wordWidth;
      }
      while (lineWidth > max) {
        const head = takeWidth(line, max);
        if (!head) break;
        out.push(head);
        line = line.slice(head.length);
        lineWidth = displayWidth(line);
      }
    }
    out.push(line);
  }
  return out;
}
