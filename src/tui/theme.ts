import type { ThemeName } from "../core/config/config.js";

export interface Palette {
  accent: string;
  accentDim: string;
  text: string;
  /** Monochrome wordmark; white on dark, charcoal on light. */
  logo: string;
  muted: string;
  faint: string;
  border: string;
  borderActive: string;
  user: string;
  assistant: string;
  reasoning: string;
  error: string;
  warn: string;
  success: string;
  code: string;
  panel: string;
  panelAlt: string;
  selection: string;
}

const dark: Palette = {
  accent: "#7dd3fc",
  accentDim: "#38bdf8",
  text: "#e4e4e7",
  logo: "#ffffff",
  muted: "#a1a1aa",
  faint: "#71717a",
  border: "#3f3f46",
  borderActive: "#0ea5e9",
  user: "#fbbf24",
  assistant: "#86efac",
  reasoning: "#c4b5fd",
  error: "#f87171",
  warn: "#fcd34d",
  success: "#4ade80",
  code: "#67e8f9",
  panel: "#18181b",
  panelAlt: "#27272a",
  selection: "#1e3a5f",
};

const light: Palette = {
  accent: "#0369a1",
  accentDim: "#0284c7",
  text: "#18181b",
  logo: "#181818",
  muted: "#52525b",
  faint: "#a1a1aa",
  border: "#d4d4d8",
  borderActive: "#0284c7",
  user: "#b45309",
  assistant: "#15803d",
  reasoning: "#6d28d9",
  error: "#b91c1c",
  warn: "#a16207",
  success: "#15803d",
  code: "#0e7490",
  panel: "#f4f4f5",
  panelAlt: "#e4e4e7",
  selection: "#dbeafe",
};

export function getPalette(name: ThemeName): Palette {
  return name === "light" ? light : dark;
}
