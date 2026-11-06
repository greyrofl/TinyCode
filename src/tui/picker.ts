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
}

export interface PickerOptions {
  title: string;
  items: PickerItem[];
  selected?: string | null;
  placeholder?: string;
  footer?: string;
  message?: string;
  messageStyle?: "warning" | "muted";
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

export interface RenderedPicker {
  lines: Line[];
  top: number;
  hits: Array<{ row: number; left: number; right: number; index: number }>;
}

export function renderPicker(picker: Picker, width: number, height: number, palette: Palette): RenderedPicker {
  const boxWidth = Math.max(12, Math.min(width - 4, 76));
  const description = picker.options.message
    ? wrapPlain(sanitizeText(picker.options.message), boxWidth - 4).slice(0, Math.max(1, Math.min(5, height - 8)))
    : [];
  const maxVisible = Math.max(1, Math.min(10, height - 6 - description.length));
  const items = picker.items;
  const visibleCount = Math.max(1, Math.min(items.length, maxVisible));
  const boxHeight = visibleCount + 4 + description.length;

  const top = Math.max(1, Math.min(height - boxHeight, Math.floor((height - boxHeight) / 2)));
  const left = Math.max(0, Math.floor((width - boxWidth) / 2));

  const border = { fg: palette.border, bg: palette.panel };
  const rows: Line[] = [];
  const hits: RenderedPicker["hits"] = [];

  const title = truncateWidth(singleLine(sanitizeText(picker.options.title)), Math.max(4, boxWidth - 8));
  const topContent = `╭─ ${title} `;
  const topFill = Math.max(0, boxWidth - displayWidth(topContent) - 1);
  rows.push(
    boxLine(
      [
        { text: topContent + "─".repeat(topFill) + "╮", style: border },
      ],
      boxWidth,
      palette,
    ),
  );

  for (const text of description) {
    rows.push(boxLine([
      { text: "│ ", style: border },
      ...padLine([{ text, style: picker.options.messageStyle === "muted" ? { fg: palette.muted, italic: true } : { fg: palette.warn } }], boxWidth - 4),
      { text: " │", style: border },
    ], boxWidth, palette));
  }

  const innerWidth = boxWidth - 4;
  const filterText = picker.options.showFilter === false ? "Choose with arrows or click an option" : picker.filter
    ? sanitizeText(picker.filter)
    : sanitizeText(picker.options.placeholder ?? "Type to filter…");
  const filterWidth = displayWidth(filterText);
  const filterPad = Math.max(0, innerWidth - filterWidth - 1);
  rows.push(
    boxLine(
      [
        { text: "│ ", style: border },
        {
          text: truncateWidth(filterText, innerWidth - 1),
          style: picker.filter ? { fg: palette.text } : { fg: palette.faint, dim: true },
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
        const label = truncateWidth(sanitizeText(singleLine(item.label)), Math.max(4, innerWidth - 4));
        const detailLimit = Math.max(0, Math.min(Math.floor(innerWidth * .35), innerWidth - displayWidth(label) - 6));
        const detail = detailLimit > 3 && item.detail ? truncateWidth(sanitizeText(singleLine(item.detail)), detailLimit) : "";
        const ruleWidth = Math.max(1, innerWidth - 4 - displayWidth(label) - displayWidth(detail));
        hits.push({ row: top + rows.length, left: left + 1, right: left + boxWidth - 2, index: start + offset });
        rows.push(boxLine([
          { text: "│ ", style: border },
          { text: "▌ ", style: { fg: palette.accent } },
          { text: label, style: { fg: palette.text, bold: true } },
          { text: ` ${"─".repeat(ruleWidth)} `, style: { fg: palette.border, dim: true } },
          { text: detail, style: { fg: palette.faint, italic: true } },
          { text: " │", style: border },
        ], boxWidth, palette));
        continue;
      }
      const marker = item.nested ? selected ? "  ❯ " : "    " : selected ? "❯ " : "  ";
      const available = boxWidth - 4 - displayWidth(marker);
      const label = truncateWidth(sanitizeText(singleLine(item.label)), available);
      const detailSpace = Math.max(0, available - displayWidth(label) - 2);
      const detail =
        item.detail && detailSpace > 4 ? `  ${truncateWidth(sanitizeText(singleLine(item.detail)), detailSpace)}` : "";
      const used = displayWidth(marker) + displayWidth(label) + displayWidth(detail);
      const padding = Math.max(0, boxWidth - 4 - used);
      hits.push({ row: top + rows.length, left: left + 1, right: left + boxWidth - 2, index: start + offset });
      rows.push(
        boxLine(
          [
            { text: "│ ", style: border },
            { text: marker, style: { fg: selected ? palette.accent : palette.faint, bold: selected } },
            { text: label, style: { fg: item.disabled ? palette.faint : selected ? palette.text : palette.muted, bold: selected && !item.disabled } },
            { text: detail, style: { fg: palette.faint } },
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

  const footer = picker.options.footer ?? "enter select · esc close · ↑↓ move";
  const footerText = truncateWidth(sanitizeText(singleLine(footer)), Math.max(4, innerWidth - 1));
  const footerPad = Math.max(0, innerWidth - displayWidth(footerText));
  rows.push(
    boxLine(
      [
        { text: "│ ", style: border },
        { text: footerText, style: { fg: palette.faint } },
        { text: " ".repeat(footerPad) },
        { text: " │", style: border },
      ],
      boxWidth,
      palette,
    ),
  );

  rows.push(boxLine([{ text: `╰${"─".repeat(Math.max(0, boxWidth - 2))}╯`, style: border }], boxWidth, palette));

  const fullWidth = rows.map((row) => padLine([...spaces(left), ...row], width));
  return { lines: fullWidth, top, hits };
}
