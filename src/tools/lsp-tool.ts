import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readOptionalInt, readString } from "./args.js";
import { assertRealPathInCwd, resolveInCwd } from "./paths.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";

const SERVERS: Record<string, { command: string; args: string[]; language: string }> = {
  ".ts": { command: "typescript-language-server", args: ["--stdio"], language: "typescript" },
  ".tsx": { command: "typescript-language-server", args: ["--stdio"], language: "typescriptreact" },
  ".js": { command: "typescript-language-server", args: ["--stdio"], language: "javascript" },
  ".jsx": { command: "typescript-language-server", args: ["--stdio"], language: "javascriptreact" },
  ".py": { command: "pylsp", args: [], language: "python" },
  ".rs": { command: "rust-analyzer", args: [], language: "rust" },
  ".go": { command: "gopls", args: [], language: "go" },
};

class LspConnection {
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  readonly diagnostics: unknown[] = [];
  receivedDiagnostics = false;
  private closed = false;
  constructor(readonly child: ChildProcessWithoutNullStreams, private readonly uri: string) {
    child.stdout.on("data", (chunk: Buffer) => { this.buffer = Buffer.concat([this.buffer, chunk]); this.parse(); });
    const fail = (error: Error): void => {
      this.closed = true;
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
    };
    child.once("error", fail);
    child.once("exit", () => fail(new Error("LSP server exited.")));
    child.stdin.on("error", fail);
    child.stderr.on("data", () => {});
  }
  private parse(): void {
    for (;;) {
      const marker = this.buffer.indexOf("\r\n\r\n");
      if (marker === -1) return;
      const header = this.buffer.subarray(0, marker).toString("ascii");
      const length = Number(/Content-Length:\s*(\d+)/i.exec(header)?.[1]);
      if (!Number.isInteger(length) || length < 0 || length > 4_000_000) {
        this.buffer = this.buffer.subarray(marker + 4);
        continue;
      }
      if (this.buffer.length < marker + 4 + length) return;
      const body = this.buffer.subarray(marker + 4, marker + 4 + length).toString("utf8");
      this.buffer = this.buffer.subarray(marker + 4 + length);
      try {
        const message = JSON.parse(body) as { id?: number | string; method?: string; params?: { uri?: string; diagnostics?: unknown[]; items?: unknown[] }; result?: unknown; error?: { message?: string } };
        if (message.method && message.id !== undefined) {
          this.send({ jsonrpc: "2.0", id: message.id, result: message.method === "workspace/configuration"
            ? (message.params?.items ?? []).map(() => ({}))
            : message.method === "workspace/applyEdit" ? { applied: false, failureReason: "Diagnostics-only client." } : null });
        } else if (typeof message.id === "number" && this.pending.has(message.id)) {
          const request = this.pending.get(message.id)!; this.pending.delete(message.id);
          message.error ? request.reject(new Error(message.error.message ?? "LSP error")) : request.resolve(message.result);
        } else if (message.method === "textDocument/publishDiagnostics" && message.params?.uri === this.uri) {
          this.receivedDiagnostics = true;
          this.diagnostics.splice(0, this.diagnostics.length, ...(message.params?.diagnostics ?? []));
        }
      } catch { /* Ignore malformed server logging on stdout. */ }
    }
  }
  send(value: unknown): void {
    const json = JSON.stringify(value);
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
  }
  request(method: string, params: unknown, timeout = 10_000): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("LSP server is closed."));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`LSP ${method} timed out.`)); }, timeout);
      this.pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      try { this.send({ jsonrpc: "2.0", id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  notify(method: string, params: unknown): void { this.send({ jsonrpc: "2.0", method, params }); }
}

function severity(value: number): string { return value === 1 ? "error" : value === 2 ? "warning" : value === 3 ? "info" : "hint"; }

async function fallback(file: string, context: ToolContext): Promise<ToolResult> {
  if (context.signal.aborted) throw new Error("Diagnostics aborted.");
  const ext = path.extname(file).toLowerCase();
  const localTsc = path.join(context.cwd, "node_modules", "typescript", "bin", "tsc");
  const hasLocalTsc = await access(localTsc).then(() => true, () => false);
  const command = ext === ".py" ? { executable: "python", args: ["-c", "import ast,sys,tokenize; ast.parse(tokenize.open(sys.argv[1]).read(), filename=sys.argv[1])", file] }
    : [".js", ".mjs", ".cjs"].includes(ext) ? { executable: process.execPath, args: ["--check", file] }
    : [".ts", ".tsx"].includes(ext) && hasLocalTsc ? { executable: process.execPath, args: [localTsc, "--noEmit", "--pretty", "false"] }
    : null;
  if (!command) return { ok: false, output: `No local language server/syntax fallback for ${ext || "this file"}. Install the appropriate LSP server or use verify (with approval).` };
  const child = spawn(command.executable, command.args, { cwd: context.cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const append = (chunk: Buffer | string): void => { output = `${output}${String(chunk)}`.slice(-Math.max(2_000, context.config.tools.maxOutputChars)); };
  child.stdout.on("data", append); child.stderr.on("data", append);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, Math.min(30_000, context.config.tools.commandTimeoutMs));
  const onAbort = (): void => { child.kill(); };
  context.signal.addEventListener("abort", onAbort, { once: true });
  const code = await new Promise<number>((resolve) => { child.once("error", (error) => { append(error.message); resolve(1); }); child.once("close", (value) => resolve(value ?? 1)); })
    .finally(() => { clearTimeout(timer); context.signal.removeEventListener("abort", onAbort); });
  if (context.signal.aborted) throw new Error("Diagnostics aborted.");
  return { ok: code === 0 && !timedOut, verificationKinds: code === 0 && !timedOut ? ["check"] : [], output: `Fallback diagnostic: ${path.basename(command.executable)}\nexit code: ${timedOut ? "timeout" : code}\n${output.trim() || "(no diagnostics)"}` };
}

export const diagnosticsTool: Tool = {
  definition: {
    name: "diagnostics",
    description: "Get structured LSP diagnostics for one file; uses a compiler fallback when no server is installed.",
    parameters: { type: "object", properties: {
      path: { type: "string", description: "Source file path relative to the working directory." },
      waitMs: { type: "integer", description: "Wait for publishDiagnostics; default 3000, max 15000.", default: 3000 },
    }, required: ["path"], additionalProperties: false },
    safe: true,
    summary: (input) => String(input.path ?? "source file"),
    example: { path: "src/index.ts" },
  },
  async run(input, context): Promise<ToolResult> {
    const requested = readString(input, "path", { trim: true, allowEmpty: false });
    const waitMs = readOptionalInt(input, "waitMs", 3000, 500, 15000);
    const file = resolveInCwd(context.cwd, requested);
    await assertRealPathInCwd(context.cwd, file);
    const text = await readFile(file, "utf8");
    const server = SERVERS[path.extname(file).toLowerCase()];
    if (!server) return fallback(file, context);
    let child: ChildProcessWithoutNullStreams;
    // These command names/arguments are fixed by SERVERS, never model input.
    // Explicit cmd avoids shell:true argument concatenation warnings for npm .cmd shims.
    try { child = process.platform === "win32"
      ? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `${server.command} ${server.args.join(" ")}`], { cwd: context.cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })
      : spawn(server.command, server.args, { cwd: context.cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }); }
    catch { return fallback(file, context); }
    const uri = pathToFileURL(file).href;
    const connection = new LspConnection(child, uri);
    const onAbort = (): void => { child.kill(); };
    context.signal.addEventListener("abort", onAbort, { once: true });
    try {
      const initialized = await connection.request("initialize", { processId: process.pid, rootUri: pathToFileURL(context.cwd).href, capabilities: { textDocument: { diagnostic: {} } }, workspaceFolders: [{ uri: pathToFileURL(context.cwd).href, name: path.basename(context.cwd) }] }) as { capabilities?: { diagnosticProvider?: unknown } };
      connection.notify("initialized", {});
      connection.notify("textDocument/didOpen", { textDocument: { uri: pathToFileURL(file).href, languageId: server.language, version: 1, text } });
      if (initialized.capabilities?.diagnosticProvider) {
        const pulled = await connection.request("textDocument/diagnostic", { textDocument: { uri } }, waitMs) as { kind?: string; items?: unknown[] };
        if (pulled.kind === "full") {
          connection.receivedDiagnostics = true;
          connection.diagnostics.splice(0, connection.diagnostics.length, ...(pulled.items ?? []));
        }
      } else await new Promise<void>((resolve) => {
        const timer = setTimeout(finish, waitMs);
        function finish(): void { clearTimeout(timer); context.signal.removeEventListener("abort", finish); resolve(); }
        context.signal.addEventListener("abort", finish, { once: true });
      });
      if (context.signal.aborted) throw new Error("Diagnostics aborted.");
      if (!connection.receivedDiagnostics) return { ok: false, output: `LSP server did not return diagnostics for ${requested} within ${waitMs}ms. This is not a clean-check result; use verify or retry with a longer wait.` };
      const diagnostics = connection.diagnostics as Array<{ range?: { start?: { line?: number; character?: number } }; severity?: number; code?: unknown; source?: string; message?: string }>;
      const lines = diagnostics.map((item) => `${requested}:${(item.range?.start?.line ?? 0) + 1}:${(item.range?.start?.character ?? 0) + 1} ${severity(item.severity ?? 3)} ${item.source ?? "lsp"}${item.code !== undefined ? `(${String(item.code)})` : ""}: ${item.message ?? "diagnostic"}`);
      return { ok: !diagnostics.some((item) => item.severity === 1), verificationKinds: diagnostics.some((item) => item.severity === 1) ? [] : ["check"], output: lines.length ? lines.join("\n") : `No LSP diagnostics for ${requested}.` };
    } catch (error) {
      if (context.signal.aborted) throw error;
      const syntax = await fallback(file, context);
      return { ...syntax, output: `LSP unavailable: ${(error as Error).message}\n${syntax.output}` };
    } finally {
      context.signal.removeEventListener("abort", onAbort);
      try { await connection.request("shutdown", null, 1000); connection.notify("exit", null); } catch { /* Stop below. */ }
      child.kill();
    }
  },
};
