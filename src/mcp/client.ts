import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import type { Config } from "../core/config/config.js";
import type { Tool, ToolParameterSchema, ToolParameters, ToolResult } from "../tools/types.js";

interface RpcResponse { id?: number; result?: unknown; error?: { code?: number; message?: string; data?: unknown }; method?: string }
interface McpTool { name: string; description?: string; inputSchema?: Record<string, unknown> }

function schema(value: unknown): ToolParameters {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const properties: Record<string, ToolParameterSchema> = {};
  const source = raw.properties && typeof raw.properties === "object" ? raw.properties as Record<string, unknown> : {};
  for (const [name, item] of Object.entries(source)) {
    const field = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const type = ["string", "number", "integer", "boolean", "object", "array"].includes(String(field.type)) ? field.type as ToolParameterSchema["type"] : "string";
    properties[name] = {
      type,
      description: typeof field.description === "string" ? field.description : `MCP argument ${name}.`,
      enum: Array.isArray(field.enum) ? field.enum.filter((entry): entry is string => typeof entry === "string") : undefined,
      default: field.default,
      items: type === "array" && field.items && typeof field.items === "object" ? { type: String((field.items as Record<string, unknown>).type ?? "string") as ToolParameterSchema["type"], description: "Array item." } : undefined,
    };
  }
  return { type: "object", properties, required: Array.isArray(raw.required) ? raw.required.filter((entry): entry is string => typeof entry === "string") : [], additionalProperties: raw.additionalProperties !== false };
}

function safeName(server: string, tool: string): string {
  return `mcp_${server}_${tool}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 96);
}

export class McpClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private id = 1;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private stderr = "";

  constructor(readonly name: string, private readonly config: Config["mcp"]["servers"][string], private readonly root: string) {}

  async connect(): Promise<Tool[]> {
    const cwd = this.config.cwd ? path.resolve(this.root, this.config.cwd) : this.root;
    this.child = spawn(this.config.command, this.config.args, {
      cwd, windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.config.env },
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stdin.on("error", (error) => this.failAll(error));
    this.child.stderr.on("data", (chunk: string) => { this.stderr = `${this.stderr}${chunk}`.slice(-8_000); });
    this.child.once("error", (error) => this.failAll(error));
    this.child.once("exit", (code) => this.failAll(new Error(`MCP ${this.name} exited (${code ?? "signal"}). ${this.stderr.trim()}`)));
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => this.receive(line));
    await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "tinycode", version: "0.5.0" },
    }, 15_000);
    this.notify("notifications/initialized", {});
    const tools: Tool[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const listed = await this.request("tools/list", cursor ? { cursor } : {}, 15_000) as { tools?: McpTool[]; nextCursor?: string };
      for (const definition of listed.tools ?? []) tools.push(this.asTool(definition));
      cursor = listed.nextCursor;
      if (cursor && seen.has(cursor)) throw new Error(`MCP ${this.name} repeated a tools/list cursor.`);
      if (cursor) seen.add(cursor);
      if (seen.size > 20) throw new Error(`MCP ${this.name} tool listing exceeded 20 pages.`);
    } while (cursor);
    return tools;
  }

  private receive(line: string): void {
    if (!line.trim()) return;
    let message: RpcResponse;
    try { message = JSON.parse(line) as RpcResponse; } catch { return; }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id); clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(`MCP ${this.name}: ${message.error.message ?? "request failed"}`));
    else pending.resolve(message.result);
  }

  private write(value: unknown): void {
    if (!this.child?.stdin.writable) throw new Error(`MCP ${this.name} is not connected.`);
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  private request(method: string, params: unknown, timeout = 30_000): Promise<unknown> {
    const id = this.id++;
    this.write({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`MCP ${this.name} ${method} timed out.`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  private notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private asTool(definition: McpTool): Tool {
    const exposed = safeName(this.name, definition.name);
    return {
      definition: {
        name: exposed,
        description: `MCP ${this.name}: ${definition.description ?? definition.name}`,
        parameters: schema(definition.inputSchema),
        safe: this.config.safe,
        summary: () => `${this.name}/${definition.name}`,
      },
      run: async (input, context): Promise<ToolResult> => {
        if (context.signal.aborted) throw new Error("MCP call aborted.");
        const id = this.id;
        const request = this.request("tools/call", { name: definition.name, arguments: input });
        let onAbort: () => void = () => {};
        const abort = new Promise<never>((_, reject) => {
          onAbort = () => {
            try { this.notify("notifications/cancelled", { requestId: id, reason: "User cancelled the TinyCode turn." }); } catch { /* Server may be closed. */ }
            const pending = this.pending.get(id);
            if (pending) {
              clearTimeout(pending.timer);
              this.pending.delete(id);
              pending.reject(new Error("MCP call aborted."));
            }
            reject(new Error("MCP call aborted."));
          };
          context.signal.addEventListener("abort", onAbort, { once: true });
        });
        const result = await Promise.race([request, abort]).finally(() => context.signal.removeEventListener("abort", onAbort)) as { content?: Array<{ type?: string; text?: string; data?: unknown }>; isError?: boolean; structuredContent?: unknown };
        const output = [
          ...(result.content ?? []).map((part) => part.text ?? (part.data !== undefined ? JSON.stringify(part.data) : "")).filter(Boolean),
          ...(result.structuredContent !== undefined ? [JSON.stringify(result.structuredContent, null, 2)] : []),
        ].join("\n").slice(0, context.config.tools.maxOutputChars) || "(empty MCP result)";
        return { ok: result.isError !== true, output };
      },
    };
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }

  dispose(): void {
    this.failAll(new Error(`MCP ${this.name} closed.`));
    this.child?.kill();
    this.child = null;
  }
}
