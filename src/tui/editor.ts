import { codePointWidth } from "../util/ansi.js";

export interface WrappedInput {
  lines: string[];
  cursorRow: number;
  cursorCol: number;
}

/**
 * Hard-wrap the composer at the given width and map the cursor into the
 * wrapped grid. Hard wrapping keeps cursor math predictable for long code
 * snippets and pasted text.
 */
export function wrapChars(chars: readonly string[], cursor: number, width: number): WrappedInput {
  const safeWidth = Math.max(1, width);
  const lines: string[] = [];
  let current = "";
  let currentWidth = 0;
  let cursorRow = 0;
  let cursorCol = 0;

  for (let index = 0; index < chars.length; index++) {
    if (index === cursor) {
      cursorRow = lines.length;
      cursorCol = currentWidth;
    }
    const char = chars[index]!;
    if (char === "\n") {
      lines.push(current);
      current = "";
      currentWidth = 0;
      continue;
    }
    const widthOfChar = codePointWidth(char.codePointAt(0) ?? 0);
    if (currentWidth + widthOfChar > safeWidth && currentWidth > 0) {
      lines.push(current);
      current = "";
      currentWidth = 0;
    }
    current += char;
    currentWidth += widthOfChar;
  }

  lines.push(current);
  if (cursor >= chars.length) {
    cursorRow = lines.length - 1;
    cursorCol = currentWidth;
  }

  return { lines, cursorRow, cursorCol };
}

/** Single-line text editor with history and readline-ish editing. */
export class Editor {
  private chars: string[] = [];
  cursor = 0;

  private history: string[] = [];
  private historyIndex: number | null = null;
  private draft: string[] = [];

  get text(): string {
    return this.chars.join("");
  }

  get value(): readonly string[] {
    return this.chars;
  }

  get isEmpty(): boolean {
    return this.chars.length === 0;
  }

  setText(text: string): void {
    this.chars = Array.from(text);
    this.cursor = this.chars.length;
    this.historyIndex = null;
  }

  clear(): void {
    this.chars = [];
    this.cursor = 0;
    this.historyIndex = null;
  }

  insert(text: string): void {
    if (!text) return;
    const added = Array.from(text.replace(/\r\n?/g, "\n"));
    this.replaceRange(this.cursor, this.cursor, added);
    this.cursor += added.length;
  }

  backspace(): void {
    if (this.cursor === 0) return;
    this.replaceRange(this.cursor - 1, this.cursor, []);
    this.cursor--;
  }

  deleteForward(): void {
    if (this.cursor >= this.chars.length) return;
    this.replaceRange(this.cursor, this.cursor + 1, []);
  }

  moveLeft(): void {
    if (this.cursor > 0) this.cursor--;
  }

  moveRight(): void {
    if (this.cursor < this.chars.length) this.cursor++;
  }

  moveHome(): void {
    this.cursor = this.lineStart();
  }

  moveEnd(): void {
    this.cursor = this.lineEnd();
  }

  moveWordLeft(): void {
    while (this.cursor > 0 && /\s/.test(this.chars[this.cursor - 1]!)) this.cursor--;
    while (this.cursor > 0 && !/\s/.test(this.chars[this.cursor - 1]!)) this.cursor--;
  }

  moveWordRight(): void {
    while (this.cursor < this.chars.length && !/\s/.test(this.chars[this.cursor]!)) this.cursor++;
    while (this.cursor < this.chars.length && /\s/.test(this.chars[this.cursor]!)) this.cursor++;
  }

  deleteWordLeft(): void {
    const end = this.cursor;
    this.moveWordLeft();
    this.replaceRange(this.cursor, end, []);
  }

  deleteToLineStart(): void {
    this.replaceRange(this.lineStart(), this.cursor, []);
    this.cursor = this.lineStart();
  }

  deleteToLineEnd(): void {
    this.replaceRange(this.cursor, this.lineEnd(), []);
  }

  /** Replace the whole visible text. Used by Tab completion. */
  replaceText(text: string): void {
    this.setText(text);
  }

  loadHistory(entries: string[]): void {
    this.history = entries.filter((entry) => entry.trim().length > 0).slice(-200);
    this.historyIndex = null;
  }

  pushHistory(text: string): void {
    if (!text.trim()) return;
    if (this.history[this.history.length - 1] !== text) this.history.push(text);
    if (this.history.length > 200) this.history.shift();
    this.historyIndex = null;
  }

  historyPrev(): boolean {
    if (this.history.length === 0) return false;
    if (this.historyIndex === null) {
      this.draft = [...this.chars];
      this.historyIndex = this.history.length - 1;
    } else if (this.historyIndex > 0) {
      this.historyIndex--;
    } else {
      return false;
    }
    this.chars = Array.from(this.history[this.historyIndex]!);
    this.cursor = this.chars.length;
    return true;
  }

  historyNext(): boolean {
    if (this.historyIndex === null) return false;
    if (this.historyIndex < this.history.length - 1) {
      this.historyIndex++;
      this.chars = Array.from(this.history[this.historyIndex]!);
    } else {
      this.chars = [...this.draft];
      this.historyIndex = null;
    }
    this.cursor = this.chars.length;
    return true;
  }

  historySnapshot(): string[] {
    return [...this.history];
  }

  private lineStart(): number {
    let index = this.cursor;
    while (index > 0 && this.chars[index - 1] !== "\n") index--;
    return index;
  }

  private lineEnd(): number {
    let index = this.cursor;
    while (index < this.chars.length && this.chars[index] !== "\n") index++;
    return index;
  }

  private replaceRange(start: number, end: number, insert: string[]): void {
    this.chars = [...this.chars.slice(0, start), ...insert, ...this.chars.slice(end)];
  }
}
