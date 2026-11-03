/**
 * Remove ANSI escapes and control characters from model output before it is
 * drawn in the terminal. Models are untrusted input: a stray escape sequence
 * must never be able to move the cursor or change terminal state.
 */
export function sanitizeText(text: string): string {
  return text
    // OSC (window title, hyperlinks, clipboard, ...)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    // CSI (cursor movement, colors, ...)
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    // Any other two-byte escape.
    .replace(/\x1b./g, "")
    // Remaining C0 controls except tab/newline, plus C1 controls.
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
}

export function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}
