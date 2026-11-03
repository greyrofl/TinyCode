import type { Palette } from "./theme.js";
import type { Line } from "./types.js";
import { displayWidth } from "../util/ansi.js";

// A title-case terminal wordmark: TinyCode, not separate TINY / CODE blocks.
const GLYPHS = [
  ["█████", "  █  ", "  █  ", "  █  ", "  █  "],
  [" ▄ ", "   ", "██ ", " █ ", " █ "],
  ["     ", "     ", "█▀▀▄ ", "█  █ ", "█  █ "],
  ["     ", "     ", "█  █ ", " ▀▀█ ", " ▄▄▀ "],
  [" ▄▄▄ ", "█    ", "█    ", "█    ", " ▀▀▀ "],
  ["     ", "     ", " ▄▄  ", "█  █ ", " ▀▀  "],
  ["   █ ", "   █ ", " ▄▄█ ", "█  █ ", " ▀▀█ "],
  ["     ", "     ", " ▄▄  ", "█▄▄█ ", " ▀▄▄ "],
];

export function buildLogo(palette: Palette, compact = false): Line[] {
  if (compact) return [[{ text: "⟨ TinyCode ⟩", style: { fg: palette.accent, bold: true } }]];
  return Array.from({ length: 5 }, (_, row) => GLYPHS.flatMap((glyph, index) => [
    { text: glyph[row]!, style: { fg: index < 4 ? palette.accent : palette.assistant, bold: true } },
    ...(index < GLYPHS.length - 1 ? [{ text: " " }] : []),
  ]));
}

export function logoWidth(lines: Line[]): number {
  return Math.max(0, ...lines.map((line) => line.reduce((sum, span) => sum + displayWidth(span.text), 0)));
}
