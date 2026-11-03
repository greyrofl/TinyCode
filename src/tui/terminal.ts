import type { ReadStream, WriteStream } from "node:tty";

/** Raw terminal lifecycle: alternate screen, cursor, bracketed paste, resize. */
export class Terminal {
  private started = false;
  private readonly dataHandlers = new Set<(chunk: string) => void>();
  private readonly resizeHandlers = new Set<() => void>();

  private readonly dataListener = (chunk: string | Buffer): void => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    for (const handler of this.dataHandlers) handler(text);
  };

  private readonly resizeListener = (): void => {
    for (const handler of this.resizeHandlers) handler();
  };

  /** Last-resort restore if the process exits without calling stop(). */
  private readonly exitListener = (): void => {
    if (!this.started) return;
    try {
      this.stdout.write("\x1b[?1006l\x1b[?1000l\x1b[?2004l\x1b[?25h\x1b[?1049l");
      this.stdin.setRawMode?.(false);
    } catch {
      // The terminal may already be gone.
    }
  };

  constructor(
    private readonly stdin: ReadStream = process.stdin,
    private readonly stdout: WriteStream = process.stdout,
  ) {}

  get width(): number {
    return this.stdout.columns && this.stdout.columns > 0 ? this.stdout.columns : 80;
  }

  get height(): number {
    return this.stdout.rows && this.stdout.rows > 0 ? this.stdout.rows : 24;
  }

  start(mouse = true): void {
    if (this.started) return;
    this.started = true;
    this.stdout.write("\x1b[?1049h\x1b[?25l\x1b[?2004h");
    if (mouse) this.stdout.write("\x1b[?1000h\x1b[?1006h");
    this.stdout.write("\x1b[2J\x1b[H");
    this.stdin.setRawMode?.(true);
    this.stdin.resume();
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", this.dataListener);
    this.stdout.on("resize", this.resizeListener);
    process.once("exit", this.exitListener);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    process.off("exit", this.exitListener);
    this.stdin.off("data", this.dataListener);
    this.stdout.off("resize", this.resizeListener);
    this.stdout.write("\x1b[?1006l\x1b[?1000l\x1b[?2004l\x1b[?25h\x1b[?1049l");
    this.stdin.setRawMode?.(false);
    this.stdin.pause();
  }

  onData(handler: (chunk: string) => void): () => void {
    this.dataHandlers.add(handler);
    return () => this.dataHandlers.delete(handler);
  }

  onResize(handler: () => void): () => void {
    this.resizeHandlers.add(handler);
    return () => this.resizeHandlers.delete(handler);
  }

  write(chunk: string): void {
    this.stdout.write(chunk);
  }
}
