import type { Palette } from "./theme.js";
import type { Line } from "./types.js";
import { displayWidth } from "../util/ansi.js";

/**
 * A large block wordmark. Every glyph is a rectangular cell of five rows and
 * rows are joined with a single column gap, so the wordmark keeps the same
 * rhythm at any terminal width. The color runs left to right across the word
 * (blue → cyan → green) instead of tinting whole letters.
 */
const GLYPHS: Record<string, string[]> = {
  T: ["█████", "  █  ", "  █  ", "  █  ", "  █  "],
  I: ["███", " █ ", " █ ", " █ ", "███"],
  N: ["█   █", "██  █", "█ █ █", "█  ██", "█   █"],
  Y: ["█   █", "█   █", " █ █ ", "  █  ", "  █  "],
  C: [" ████", "█    ", "█    ", "█    ", " ████"],
  O: [" ███ ", "█   █", "█   █", "█   █", " ███ "],
  D: ["████ ", "█   █", "█   █", "█   █", "████ "],
  E: ["█████", "█    ", "████ ", "█    ", "█████"],
};

const WORD = "TINYCODE";
const GAP = " ";
const ROWS = 5;

/** Color stops of the wordmark gradient, in left-to-right order. */
const STOPS: Array<keyof Palette> = ["accentDim", "code", "assistant"];

type Rgb = [number, number, number];

function hexToRgb(color: string): Rgb | null {
  const match = /^#([0-9a-f]{6})$/i.exec(color);
  if (!match) return null;
  const value = parseInt(match[1]!, 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function rgbToHex(rgb: Rgb): string {
  return `#${rgb.map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}`;
}

function mix(from: Rgb, to: Rgb, ratio: number): Rgb {
  return [
    from[0] + (to[0] - from[0]) * ratio,
    from[1] + (to[1] - from[1]) * ratio,
    from[2] + (to[2] - from[2]) * ratio,
  ];
}

/**
 * Sample the palette gradient into a small ramp. Non-hex palettes (for example
 * ANSI indexes) fall back to a single accent color instead of guessing.
 */
function gradientRamp(palette: Palette, steps: number): string[] {
  const count = Math.max(2, Math.min(32, steps));
  const stops = STOPS.map((key) => hexToRgb(palette[key]));
  if (stops.some((stop) => stop === null)) {
    return Array.from({ length: count }, () => palette.accent);
  }
  const colors = stops as Rgb[];
  const ramp: string[] = [];
  for (let index = 0; index < count; index++) {
    const position = (index / (count - 1)) * (colors.length - 1);
    const start = Math.min(colors.length - 2, Math.floor(position));
    ramp.push(rgbToHex(mix(colors[start]!, colors[start + 1]!, position - start)));
  }
  return ramp;
}

/** Merge adjacent cells that share a gradient step into a single span. */
function gradientSpans(row: string, ramp: string[]): Line {
  const line: Line = [];
  let buffer = "";
  let color: string | null = null;

  const flush = (): void => {
    if (!buffer) return;
    line.push(color ? { text: buffer, style: { fg: color } } : { text: buffer });
    buffer = "";
  };

  const chars = [...row];
  chars.forEach((char, column) => {
    const next = char === " "
      ? null
      : ramp[Math.round((column / Math.max(1, chars.length - 1)) * (ramp.length - 1))]!;
    if (next !== color) {
      flush();
      color = next;
    }
    buffer += char;
  });
  flush();
  return line;
}

function wordmark(palette: Palette): Line[] {
  const rows = Array.from({ length: ROWS }, (_, row) =>
    [...WORD].map((letter) => GLYPHS[letter]![row]!).join(GAP),
  );
  const width = Math.max(...rows.map(displayWidth));
  const ramp = gradientRamp(palette, width);
  return rows.map((row) => gradientSpans(row, ramp));
}

function compactMark(palette: Palette): Line[] {
  const ramp = gradientRamp(palette, 16);
  const word = "TinyCode";
  const line: Line = [{ text: "◆ ", style: { fg: palette.accent, bold: true } }];
  [...word].forEach((char, index) => {
    const color = ramp[Math.round((index / Math.max(1, word.length - 1)) * (ramp.length - 1))]!;
    line.push({ text: char, style: { fg: color, bold: true } });
  });
  return [line];
}

export function buildLogo(palette: Palette, compact = false): Line[] {
  return compact ? compactMark(palette) : wordmark(palette);
}

export function logoWidth(lines: Line[]): number {
  return Math.max(0, ...lines.map((line) => line.reduce((sum, span) => sum + displayWidth(span.text), 0)));
}
