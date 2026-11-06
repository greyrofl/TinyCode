import type { Palette } from "./theme.js";
import type { Line } from "./types.js";
import { displayWidth } from "../util/ansi.js";

/** A five-by-seven pixel font with consistent letter cells and spacing. */
const GLYPHS: Record<string, readonly number[]> = {
  T: [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100],
  I: [0b01110, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  N: [0b10001, 0b11001, 0b11001, 0b10101, 0b10011, 0b10011, 0b10001],
  Y: [0b10001, 0b10001, 0b01010, 0b00100, 0b00100, 0b00100, 0b00100],
  C: [0b01111, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b01111],
  O: [0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  D: [0b11110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b11110],
  E: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111],
};

const WORD = "TINYCODE";
const GAP = " ";
const GLYPH_WIDTH = 5;
const GLYPH_HEIGHT = 7;
const PIXELS = [" ", "▄", "▀", "█"];

/** Pack two pixel rows into each cell instead of stretching pixels vertically. */
function pixelRow(upper: number, lower: number): string {
  return Array.from({ length: GLYPH_WIDTH }, (_, column) => {
    const bit = 1 << (GLYPH_WIDTH - column - 1);
    return PIXELS[(upper & bit ? 2 : 0) + (lower & bit ? 1 : 0)]!;
  }).join("");
}

function wordmark(palette: Palette): Line[] {
  const rows = Array.from({ length: Math.ceil(GLYPH_HEIGHT / 2) }, (_, row) =>
    [...WORD].map((letter) => {
      const glyph = GLYPHS[letter]!;
      return pixelRow(glyph[row * 2] ?? 0, glyph[row * 2 + 1] ?? 0);
    }).join(GAP),
  );
  return rows.map((text) => [{ text, style: { fg: palette.logo } }]);
}

function compactMark(palette: Palette): Line[] {
  return [[{ text: "TinyCode", style: { fg: palette.logo, bold: true } }]];
}

export function buildLogo(palette: Palette, compact = false): Line[] {
  return compact ? compactMark(palette) : wordmark(palette);
}

export function logoWidth(lines: Line[]): number {
  return Math.max(0, ...lines.map((line) => line.reduce((sum, span) => sum + displayWidth(span.text), 0)));
}
