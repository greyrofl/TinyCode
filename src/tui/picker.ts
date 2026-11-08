import type { Key } from "./keys.js";
import type { Palette } from "./theme.js";
import type { Line } from "./types.js";
import { displayWidth, truncateWidth, wrapPlain } from "../util/ansi.js";
import { sanitizeText, singleLine } from "../util/text.js";
import { padLine, spaces } from "./types.js";

export interface PickerItem {
  value: string;
  label: string;
  detail?: string;
  disabled?: boolean;
  /** Non-selectable Markdown-like category heading. */
  heading?: boolean;
  /** Indent an item under a category heading. */
  nested?: boolean;
  /** Optional semantic color used for the marker and label. */
  tone?: "accent" | "info" | "success" | "warning" | "danger" | "reasoning" | "muted";
}

export interface PickerOptions {
  title: string;
  items: PickerItem[];
  selected?: string | null;
  placeholder?: string;
  footer?: string;
  message?: string;
  messageStyle?: "warning" | "muted" | "info" | "success";
  showFilter?: boolean;
}

export type PickerResult =
  | { type: "cancel" }
  | { type: "select"; item: PickerItem }
  | { type: "update" }
  | { type: "unhandled" };

export class Picker {
  filter = "";
  index = 0;

  constructor(readonly options: PickerOptions) {
    const selectedIndex = options.selected
      ? options.items.findIndex((item) => item.value === options.selected)
      : -1;
    if (selectedIndex > 0) this.index = selectedIndex;
    if (options.items[this.index]?.disabled) this.index = Math.max(0, options.items.findIndex((item) => !item.disabled));
  }

  get items(): PickerItem[] {
    const needle = this.filter.trim().toLowerCase();
    if (!needle) return this.options.items;
    const matches = (item: PickerItem) => !item.heading && `${item.label} ${item.detail ?? ""} ${item.value}`.toLowerCase().includes(needle);
    return this.options.items.filter((item, index, all) => {
      if (!item.heading) return matches(item);
      const next = all.findIndex((candidate, candidateIndex) => candidateIndex > index && candidate.heading);
      return all.slice(index + 1, next === -1 ? undefined : next).some(matches);
    });
  }

  handleKey(key: Key): PickerResult {
    if (key.name === "escape" || (key.name === "char" && key.ctrl && key.text === "c")) {
      return { type: "cancel" };
    }
    if (key.name === "enter") {
      const item = this.items[this.index];
      return item && !item.disabled ? { type: "select", item } : { type: "update" };
    }
    if (key.name === "up" || key.name === "wheelup" || (key.name === "char" && key.ctrl && key.text === "p")) {
      this.move(-1);
      return { type: "update" };
    }
    if (key.name === "down" || key.name === "wheeldown" || (key.name === "char" && key.ctrl && key.text === "n")) {
      this.move(1);
      return { type: "update" };
    }
    if (key.name === "pageup") {
      this.move(-5);
      return { type: "update" };
    }
    if (key.name === "pagedown") {
      this.move(5);
      return { type: "update" };
    }
    if (key.name === "backspace") {
      this.filter = Array.from(this.filter).slice(0, -1).join("");
      this.index = Math.max(0, this.items.findIndex((item) => !item.disabled && !item.heading));
      return { type: "update" };
    }
    if (this.options.showFilter !== false && key.name === "char" && !key.ctrl && !key.alt && key.text !== undefined) {
      const text = key.text.replace(/[\r\n\t]/g, " ");
      if (text) {
        this.filter += text;
        this.index = Math.max(0, this.items.findIndex((item) => !item.disabled && !item.heading));
      }
      return { type: "update" };
    }
    return { type: "unhandled" };
  }

  private move(delta: number): void {
    const count = this.items.length;
    if (count === 0) {
      this.index = 0;
      return;
    }
    let next = Math.max(0, Math.min(count - 1, this.index + delta));
    const step = delta >= 0 ? 1 : -1;
    while (next >= 0 && next < count && (this.items[next]?.disabled || this.items[next]?.heading)) next += step;
    if (next >= 0 && next < count) this.index = next;
  }
}

function boxLine(content: Line, boxWidth: number, palette: Palette, selected = false): Line {
  const background = selected ? palette.selection : palette.panel;
  return padLine(
    content.map((span) => ({ ...span, style: { ...span.style, bg: background } })),
    boxWidth,
    { bg: background },
  );
}

function toneColor(item: PickerItem, palette: Palette): string {
  switch (item.tone) {
    case "accent": return palette.accent;
    case "info": return palette.code;
    case "success": return palette.success;
    case "warning": return palette.warn;
    case "danger": return palette.error;
    case "reasoning": return palette.reasoning;
    case "muted": return palette.muted;
    default: return palette.text;
  }
}

function messageColor(style: PickerOptions["messageStyle"], palette: Palette): string {
  if (style === "muted") return palette.muted;
  if (style === "info") return palette.code;
  if (style === "success") return palette.success;
  return palette.warn;
}

function wrapLimited(text: string, width: number, limit: number): string[] {
  const all = wrapPlain(text, width);
  if (all.length <= limit) return all;
  const shown = all.slice(0, limit);
  shown[shown.length - 1] = truncateWidth(`${shown.at(-1) ?? ""}…`, width);
  return shown;
}

function footerSpans(text: string, palette: Palette): Line {
  const parts = text.split(/(enter|esc|↑↓|click|\by\b|\ba\b|\bn\b)/gi);
  return parts.filter(Boolean).map((part) => {
    if (/^enter$/i.test(part)) return { text: part, style: { fg: palette.success, bold: true } };
    if (/^esc$/i.test(part)) return { text: part, style: { fg: palette.warn, bold: true } };
    if (/^(?:↑↓|click)$/i.test(part)) return { text: part, style: { fg: palette.accent } };
    if (/^[yan]$/i.test(part)) return { text: part, style: { fg: part.toLowerCase() === "n" ? palette.error : palette.success, bold: true } };
    return { text: part, style: { fg: palette.faint } };
  });
}

export interface RenderedPicker {
  lines: Line[];
  top: number;
  hits: Array<{ row: number; left: number; right: number; index: number }>;
}

export function renderPicker(picker: Picker, width: number, height: number, palette: Palette): RenderedPicker {
  const boxWidth = Math.max(12, Math.min(width - 4, 76));
  const innerWidth = boxWidth - 4;
  const description = picker.options.message
    ? wrapLimited(sanitizeText(picker.options.message), innerWidth, Math.max(1, Math.min(5, height - 8)))
    : [];
  const items = picker.items;
  const selectedItem = items[picker.index];
  // The row already identifies the selected label. Use the preview for its
  // full detail first; otherwise a long label can consume every narrow line
  // before the useful metadata becomes visible.
  const previewText = selectedItem && !selectedItem.heading
    ? selectedItem.detail ? sanitizeText(singleLine(selectedItem.detail))
      : displayWidth(selectedItem.label) > Math.max(8, innerWidth - 6) ? sanitizeText(singleLine(selectedItem.label)) : ""
    : "";
  const preview = previewText ? wrapLimited(previewText, Math.max(4, innerWidth - 3), Math.max(1, Math.min(3, height - description.length - 9))) : [];
  const defaultFooter = innerWidth < 34 ? "enter · esc · ↑↓" : innerWidth < 48 ? "enter select · esc close · ↑↓" : "enter select · esc close · ↑↓ move · click choose";
  const footer = picker.options.footer ?? defaultFooter;
  const footerLines = wrapLimited(sanitizeText(singleLine(footer)), innerWidth, 2);
  const maxVisible = Math.max(1, Math.min(10, height - 5 - footerLines.length - description.length - preview.length));
  const visibleCount = Math.max(1, Math.min(items.length, maxVisible));
  const boxHeight = visibleCount + 3 + footerLines.length + description.length + preview.length;

  const top = Math.max(1, Math.min(height - boxHeight, Math.floor((height - boxHeight) / 2)));
  const left = Math.max(0, Math.floor((width - boxWidth) / 2));

  const border = { fg: palette.border, bg: palette.panel };
  const rows: Line[] = [];
  const hits: RenderedPicker["hits"] = [];

  const title = truncateWidth(singleLine(sanitizeText(picker.options.title)), Math.max(4, boxWidth - 8));
  const topPrefix = "╭─ ";
  const topFill = Math.max(0, boxWidth - displayWidth(topPrefix) - displayWidth(title) - 2);
  rows.push(
    boxLine(
      [
        { text: topPrefix, style: border },
        { text: title, style: { fg: palette.accent, bg: palette.panel, bold: true } },
        { text: ` ${"─".repeat(topFill)}╮`, style: border },
      ],
      boxWidth,
      palette,
    ),
  );

  for (const text of description) {
    rows.push(boxLine([
      { text: "│ ", style: border },
      ...padLine([{ text, style: { fg: messageColor(picker.options.messageStyle, palette), italic: picker.options.messageStyle === "muted" } }], innerWidth),
      { text: " │", style: border },
    ], boxWidth, palette));
  }

  const filterText = picker.options.showFilter === false ? innerWidth < 34 ? "↑↓ choose · enter select" : "Choose with arrows or click an option" : picker.filter
    ? sanitizeText(picker.filter)
    : sanitizeText(picker.options.placeholder ?? "Type to filter…");
  const shownFilter = truncateWidth(filterText, innerWidth - 1);
  const filterPad = Math.max(0, innerWidth - displayWidth(shownFilter) - 1);
  rows.push(
    boxLine(
      [
        { text: "│ ", style: border },
        {
          text: shownFilter,
          style: picker.filter ? { fg: palette.code, bold: true } : { fg: palette.muted, dim: true },
        },
        { text: "▏", style: { fg: palette.accent } },
        { text: " ".repeat(filterPad) },
        { text: " │", style: border },
      ],
      boxWidth,
      palette,
    ),
  );

  let start = 0;
  if (items.length > visibleCount) {
    start = Math.max(0, Math.min(items.length - visibleCount, picker.index - Math.floor(visibleCount / 2)));
  }

  if (items.length === 0) {
    rows.push(
      boxLine(
        [
          { text: "│ ", style: border },
          { text: "No matches", style: { fg: palette.faint } },
          { text: " ".repeat(Math.max(0, innerWidth - 10)) },
          { text: " │", style: border },
        ],
        boxWidth,
        palette,
      ),
    );
  } else {
    for (let offset = 0; offset < visibleCount; offset++) {
      const item = items[start + offset];
      if (!item) break;
      const selected = start + offset === picker.index;
      if (item.heading) {
        const label = truncateWidth(sanitizeText(singleLine(item.label)), Math.max(4, innerWidth - 5));
        const detailLimit = Math.max(0, Math.min(Math.floor(innerWidth * .35), innerWidth - displayWidth(label) - 6));
        const detail = detailLimit > 3 && item.detail ? truncateWidth(sanitizeText(singleLine(item.detail)), detailLimit) : "";
        const ruleWidth = Math.max(1, innerWidth - 4 - displayWidth(label) - displayWidth(detail));
        hits.push({ row: top + rows.length, left: left + 1, right: left + boxWidth - 2, index: start + offset });
        rows.push(boxLine([
          { text: "│ ", style: border },
          { text: "▌ ", style: { fg: toneColor(item, palette) } },
          { text: label, style: { fg: toneColor(item, palette), bold: true } },
          { text: ` ${"─".repeat(ruleWidth)} `, style: { fg: palette.border, dim: true } },
          { text: detail, style: { fg: palette.faint, italic: true } },
          { text: " │", style: border },
        ], boxWidth, palette));
        continue;
      }
      const marker = item.nested ? selected ? "  ❯ " : "    " : selected ? "❯ " : "  ";
      const available = boxWidth - 4 - displayWidth(marker);
      const rawDetail = item.detail ? sanitizeText(singleLine(item.detail)) : "";
      const detailWidth = rawDetail && available >= 24
        ? Math.min(displayWidth(rawDetail), Math.max(8, Math.min(Math.floor(available * .42), available - 10))) : 0;
      const labelWidth = Math.max(4, available - (detailWidth ? detailWidth + 2 : 0));
      const label = truncateWidth(sanitizeText(singleLine(item.label)), labelWidth);
      const detail = detailWidth ? `  ${truncateWidth(rawDetail, detailWidth)}` : "";
      const used = displayWidth(marker) + displayWidth(label) + displayWidth(detail);
      const padding = Math.max(0, boxWidth - 4 - used);
      hits.push({ row: top + rows.length, left: left + 1, right: left + boxWidth - 2, index: start + offset });
      rows.push(
        boxLine(
          [
            { text: "│ ", style: border },
            { text: marker, style: { fg: selected ? toneColor(item, palette) : palette.faint, bold: selected, dim: item.disabled } },
            { text: label, style: { fg: item.tone ? toneColor(item, palette) : item.disabled ? palette.faint : selected ? palette.text : palette.muted, bold: selected && !item.disabled, dim: item.disabled } },
            { text: detail, style: { fg: item.disabled ? palette.faint : selected ? palette.code : palette.faint } },
            { text: " ".repeat(padding) },
            { text: " │", style: border },
          ],
          boxWidth,
          palette,
          selected,
        ),
      );
    }
  }

  for (const [index, text] of preview.entries()) {
    const item = selectedItem!;
    rows.push(boxLine([
      { text: "│ ", style: border },
      { text: index === 0 ? "◆ " : "  ", style: { fg: toneColor(item, palette) } },
      ...padLine([{ text, style: { fg: index === 0 ? palette.text : palette.muted, italic: index > 0 } }], innerWidth - 2),
      { text: " │", style: border },
    ], boxWidth, palette));
  }

  for (const text of footerLines) {
    rows.push(boxLine([
      { text: "│ ", style: border },
      ...padLine(footerSpans(text, palette), innerWidth),
      { text: " │", style: border },
    ], boxWidth, palette));
  }

  rows.push(boxLine([{ text: `╰${"─".repeat(Math.max(0, boxWidth - 2))}╯`, style: border }], boxWidth, palette));

  const fullWidth = rows.map((row) => padLine([...spaces(left), ...row], width));
  return { lines: fullWidth, top, hits };
}
