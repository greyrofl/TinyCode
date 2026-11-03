import type { Line } from "./types.js";
import { emitLine } from "./types.js";

/**
 * Tracks the previously drawn frame and emits only changed lines using
 * absolute cursor positioning. We never scroll the terminal, so layout math
 * stays valid even for very long conversations.
 */
export class Screen {
  private previous: string[] = [];
  private width = 0;
  private height = 0;

  constructor(private readonly write: (chunk: string) => void) {}

  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.previous = [];
    this.write("\x1b[2J\x1b[H");
  }

  render(frame: Line[], cursor: { row: number; col: number } | null): void {
    if (this.width === 0 || this.height === 0) return;

    const next: string[] = [];
    for (let row = 0; row < this.height; row++) {
      next[row] = emitLine(frame[row] ?? [], this.width);
    }

    let buffer = "";
    for (let row = 0; row < this.height; row++) {
      if (this.previous[row] !== next[row]) {
        buffer += `\x1b[${row + 1};1H\x1b[2K${next[row]}`;
      }
    }

    if (cursor) {
      const row = Math.max(1, Math.min(this.height, cursor.row + 1));
      const col = Math.max(1, Math.min(this.width, cursor.col + 1));
      buffer += `\x1b[${row};${col}H\x1b[?25h`;
    } else {
      buffer += "\x1b[?25l";
    }

    this.previous = next;
    if (buffer) this.write(buffer);
  }

  clear(): void {
    this.previous = [];
    this.write("\x1b[2J\x1b[H");
  }
}
