export type KeyName =
  | "char"
  | "enter"
  | "newline"
  | "tab"
  | "backspace"
  | "delete"
  | "escape"
  | "up"
  | "down"
  | "left"
  | "right"
  | "home"
  | "end"
  | "pageup"
  | "pagedown"
  | "wheelup"
  | "wheeldown"
  | "click"
  | "insert"
  | "unknown";

export interface Key {
  name: KeyName;
  text?: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  x?: number;
  y?: number;
}

interface Modifiers {
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
}

function decodeModifier(modifier: number): Modifiers {
  const bits = Math.max(0, modifier - 1);
  const modifiers: Modifiers = {};
  if (bits & 1) modifiers.shift = true;
  if (bits & 2) modifiers.alt = true;
  if (bits & 4) modifiers.ctrl = true;
  return modifiers;
}

/**
 * Parses terminal input chunks into keys. Supports CSI/SS3 cursor keys,
 * modifiers, bracketed paste and a lone Escape (via a short timeout).
 */
export class KeyParser {
  private buffer = "";
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly onKey: (key: Key) => void) {}

  push(chunk: string): void {
    this.buffer += chunk;
    this.drain();
    this.armEscapeTimer();
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.buffer = "";
  }

  private armEscapeTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.buffer !== "\x1b") return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.buffer === "\x1b") {
        this.buffer = "";
        this.onKey({ name: "escape" });
      } else {
        this.drain();
      }
    }, 35);
  }

  private drain(): void {
    for (;;) {
      const key = this.tryParse();
      if (!key) break;
      this.onKey(key);
    }
  }

  private tryParse(): Key | null {
    if (!this.buffer) return null;

    if (this.buffer.startsWith("\x1b[200~")) {
      const end = this.buffer.indexOf("\x1b[201~", 6);
      if (end === -1) return null;
      const text = this.buffer.slice(6, end);
      this.buffer = this.buffer.slice(end + 6);
      return { name: "char", text };
    }

    if (this.buffer.startsWith("\x1b[<")) {
      const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(this.buffer);
      if (!match) {
        if (this.buffer.length > 64) {
          this.buffer = "";
          return { name: "unknown" };
        }
        return null;
      }
      this.buffer = this.buffer.slice(match[0].length);
      if (match[4] !== "M") return { name: "unknown" };
      const button = Number(match[1]);
      if ((button & 64) === 0) {
        return (button & 3) === 0 && (button & 32) === 0
          ? { name: "click", x: Number(match[2]) - 1, y: Number(match[3]) - 1 }
          : { name: "unknown" };
      }
      const direction = button & 3;
      if (direction === 0) return { name: "wheelup" };
      if (direction === 1) return { name: "wheeldown" };
      return { name: "unknown" };
    }

    if (this.buffer.startsWith("\x1b[")) return this.parseCsi();

    if (this.buffer.startsWith("\x1bO")) {
      if (this.buffer.length < 3) return null;
      const final = this.buffer[2]!;
      this.buffer = this.buffer.slice(3);
      switch (final) {
        case "A":
          return { name: "up" };
        case "B":
          return { name: "down" };
        case "C":
          return { name: "right" };
        case "D":
          return { name: "left" };
        case "H":
          return { name: "home" };
        case "F":
          return { name: "end" };
        default:
          return { name: "unknown" };
      }
    }

    if (this.buffer === "\x1b") return null;

    if (this.buffer.startsWith("\x1b")) {
      const rest = this.buffer.slice(1);
      const codePoint = rest.codePointAt(0);
      if (codePoint === undefined) return null;
      const char = String.fromCodePoint(codePoint);
      this.buffer = this.buffer.slice(1 + char.length);
      if (char === "\r") return { name: "enter", alt: true };
      if (char === "\n") return { name: "newline", alt: true };
      if (char === "\x7f" || char === "\x08") return { name: "backspace", alt: true };
      if (char === "\t") return { name: "tab", alt: true };
      return { name: "char", text: char, alt: true };
    }

    const codePoint = this.buffer.codePointAt(0)!;
    const char = String.fromCodePoint(codePoint);

    if (char === "\r") {
      this.buffer = this.buffer.slice(1);
      return { name: "enter" };
    }
    if (char === "\n") {
      this.buffer = this.buffer.slice(1);
      return { name: "newline" };
    }
    if (char === "\t") {
      this.buffer = this.buffer.slice(1);
      return { name: "tab" };
    }
    if (char === "\x7f" || char === "\x08") {
      this.buffer = this.buffer.slice(1);
      return { name: "backspace" };
    }
    if (codePoint < 32) {
      this.buffer = this.buffer.slice(1);
      if (codePoint === 0) return { name: "char", text: " ", ctrl: true };
      return { name: "char", text: String.fromCharCode(96 + codePoint), ctrl: true };
    }

    this.buffer = this.buffer.slice(char.length);
    return { name: "char", text: char };
  }

  private parseCsi(): Key | null {
    const match = /^\x1b\[([0-9;?]*)([A-Za-z~])/.exec(this.buffer);
    if (!match) {
      if (this.buffer.length > 64) {
        this.buffer = "";
        return { name: "unknown" };
      }
      return null;
    }

    const params = match[1] ?? "";
    const final = match[2] ?? "";
    this.buffer = this.buffer.slice(match[0].length);

    if (final === "~") {
      const parts = params.split(";");
      const code = Number(parts[0]);
      const modifiers = decodeModifier(Number(parts[1] ?? 1));
      switch (code) {
        case 1:
        case 7:
          return { name: "home", ...modifiers };
        case 2:
          return { name: "insert", ...modifiers };
        case 3:
          return { name: "delete", ...modifiers };
        case 4:
        case 8:
          return { name: "end", ...modifiers };
        case 5:
          return { name: "pageup", ...modifiers };
        case 6:
          return { name: "pagedown", ...modifiers };
        default:
          return { name: "unknown", ...modifiers };
      }
    }

    const parts = params ? params.split(";").map(Number) : [];
    const modifiers = decodeModifier(parts[1] ?? 1);
    switch (final) {
      case "A":
        return { name: "up", ...modifiers };
      case "B":
        return { name: "down", ...modifiers };
      case "C":
        return { name: "right", ...modifiers };
      case "D":
        return { name: "left", ...modifiers };
      case "H":
        return { name: "home", ...modifiers };
      case "F":
        return { name: "end", ...modifiers };
      case "Z":
        return { name: "tab", shift: true };
      default:
        return { name: "unknown", ...modifiers };
    }
  }
}
