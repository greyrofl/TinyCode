import { errorMessage } from "../util/errors.js";
import type { ToolDefinition, ToolParameterSchema } from "./types.js";

const OPEN = "<tool_call>";
const CLOSE = "</tool_call>";
const NATIVE_PROTOCOLS = [
  { open: "<|tool_call>", close: "<tool_call|>" },
  { open: "<|toolcall|>", close: "<tool_call|>" },
  { open: "<|toolcall|>", close: "<toolcall|>" },
];
const TOOL_NAMES = [
  "read_file", "read_files", "list_dir", "find_files", "search_text", "file_info",
  "create_file", "replace_file", "edit_file", "apply_patch", "make_directory", "move_path", "copy_path", "delete_file", "delete_directory",
  "git_status", "git_diff", "git_log", "git_show", "diagnostics", "verify", "execute_command",
  "start_process", "process_status", "list_processes", "stop_process", "fetch_url", "web_search", "say",
  "continue_work", "work_done",
];

export interface ParsedToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ParsedToolCalls {
  /** Assistant text with tool-call blocks removed. */
  text: string;
  calls: ParsedToolCall[];
  errors: string[];
  issues: ToolParseIssue[];
}

export interface ToolParseIssue {
  message: string;
  fragment: string;
  toolName?: string;
  kind?: "incomplete" | "json" | "empty";
}

function stripFence(text: string): string {
  return text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
}

/** Repair common small-model JSON mistakes without changing its structure. */
function repairJson(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (!inString) {
      if (char === ",") {
        let next = index + 1;
        while (next < text.length && /\s/.test(text[next]!)) next++;
        if (text[next] === "}" || text[next] === "]") continue;
      }
      out += char;
      if (char === '"') inString = true;
      continue;
    }

    if (escaped) {
      if ('"\\/bfnrtu'.includes(char)) {
        out += char;
      } else {
        // Recover Windows paths such as C:\Users that contain invalid JSON escapes.
        out += `\\${char}`;
      }
      escaped = false;
      continue;
    }
    if (char === "\\") {
      out += char;
      escaped = true;
    } else if (char === '"') {
      out += char;
      inString = false;
    } else if (char === "\n") {
      out += "\\n";
    } else if (char === "\r") {
      out += "\\r";
    } else if (char === "\t") {
      out += "\\t";
    } else {
      out += char;
    }
  }
  return out;
}

function parseJsonObject(text: string): Record<string, unknown> {
  const clean = stripFence(text);
  try {
    return JSON.parse(clean) as Record<string, unknown>;
  } catch {
    return JSON.parse(repairJson(clean)) as Record<string, unknown>;
  }
}

function toolNameIn(text: string): string | undefined {
  return /["']?name["']?\s*:\s*["']([^"']+)/i.exec(text)?.[1]
    ?? /<function=([A-Za-z_][A-Za-z0-9_.:-]*)>/i.exec(text)?.[1];
}

function xmlArgument(raw: string, schema?: ToolParameterSchema): unknown {
  // Remove only the XML framing newline. File content/oldText/newText must not
  // be trimmed or HTML-decoded, including literal JSON, quotes and tool tags.
  const text = raw.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
  if (!schema || schema.type === "string") return text;
  const value = JSON.parse(text.trim());
  const valid = schema.type === "integer" ? Number.isInteger(value)
    : schema.type === "number" ? typeof value === "number" && Number.isFinite(value)
      : schema.type === "boolean" ? typeof value === "boolean"
        : schema.type === "array" ? Array.isArray(value)
          : schema.type === "object" ? value !== null && typeof value === "object" && !Array.isArray(value) : false;
  if (!valid) throw new Error(`XML parameter must have schema type ${schema.type}.`);
  return value;
}

function parseXmlCall(body: string, definitions: readonly Pick<ToolDefinition, "name" | "parameters">[]): ParsedToolCall {
  const functionTag = /^\s*<function=([A-Za-z_][A-Za-z0-9_.:-]*)>/.exec(body);
  if (!functionTag) throw new Error("Invalid Qwen function tag.");
  const name = functionTag[1]!;
  const definition = definitions.find((tool) => tool.name === name);
  const args: Record<string, unknown> = Object.create(null);
  let cursor = functionTag[0].length;
  for (;;) {
    const rest = body.slice(cursor).trimStart();
    cursor = body.length - rest.length;
    if (rest.startsWith("</function>")) {
      if (rest.slice("</function>".length).trim()) throw new Error("Unexpected content after Qwen function block.");
      return { name, arguments: args };
    }
    const parameter = /^<parameter=([A-Za-z_][A-Za-z0-9_.:-]*)>/.exec(rest);
    if (!parameter) throw new Error("Incomplete or malformed Qwen parameter/function block.");
    const key = parameter[1]!;
    if (Object.hasOwn(args, key)) throw new Error(`Duplicate XML parameter: ${key}`);
    const start = cursor + parameter[0].length;
    const end = body.indexOf("</parameter>", start);
    if (end === -1) throw new Error(`Unclosed XML parameter: ${key}`);
    args[key] = xmlArgument(body.slice(start, end), definition?.parameters.properties[key]);
    cursor = end + "</parameter>".length;
  }
}

function quoteNativeKeys(text: string): string {
  let out = "", quoted = false, escaped = false, expectKey = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quoted) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') { quoted = true; out += char; continue; }
    if (char === "{" || char === ",") { expectKey = true; out += char; continue; }
    if (expectKey && /\s/.test(char)) { out += char; continue; }
    if (expectKey && /[A-Za-z_]/.test(char)) {
      let end = index + 1;
      while (end < text.length && /[A-Za-z0-9_.-]/.test(text[end]!)) end++;
      let colon = end;
      while (colon < text.length && /\s/.test(text[colon]!)) colon++;
      if (text[colon] === ":") {
        out += `${JSON.stringify(text.slice(index, end))}${text.slice(end, colon + 1)}`;
        index = colon;
        expectKey = false;
        continue;
      }
    }
    expectKey = false;
    out += char;
  }
  return out;
}

function canonicalNativeName(name: string): string {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  return TOOL_NAMES.find((candidate) => candidate.replaceAll("_", "").toLowerCase() === normalized) ?? name.trim();
}

function nativeCall(body: string): ParsedToolCall {
  // Some Gemma llama.cpp templates surface the quote control token literally
  // inside native DSL arrays: [<|"|>a.ts<|"|>]. It is a protocol artifact,
  // not project content, and maps back to an ordinary JSON double quote.
  body = body.replaceAll('<|"|>', '"');
  const match = /^\s*call:\s*([^\s{]+)\s*(\{[\s\S]*\})\s*$/.exec(body);
  if (!match) throw new Error("invalid native tool-call DSL.");
  return { name: canonicalNativeName(match[1]!), arguments: parseJsonObject(quoteNativeKeys(match[2]!)) };
}

/** Convert Gemma/native llama.cpp DSL into TinyCode's guarded text protocol. */
export function normalizeNativeToolCalls(raw: string): string {
  let cursor = 0, output = "";
  while (cursor < raw.length) {
    const lower = raw.toLowerCase();
    const found = NATIVE_PROTOCOLS.map((protocol) => ({ protocol, index: lower.indexOf(protocol.open, cursor) }))
      .filter((item) => item.index !== -1).sort((a, b) => a.index - b.index)[0];
    const standard = lower.indexOf(OPEN, cursor);
    if (standard !== -1 && (!found || standard < found.index)) {
      // Standard JSON/XML parameters can contain literal native tool tags as
      // file data. Never normalize those inside an enclosing call body.
      const end = closingTag(raw, standard + OPEN.length);
      if (end === -1) { output += raw.slice(cursor); break; }
      output += raw.slice(cursor, end + CLOSE.length);
      cursor = end + CLOSE.length;
      continue;
    }
    if (!found) { output += raw.slice(cursor); break; }
    output += raw.slice(cursor, found.index);
    const bodyStart = found.index + found.protocol.open.length;
    const end = lower.indexOf(found.protocol.close, bodyStart);
    const body = raw.slice(bodyStart, end === -1 ? raw.length : end).trim();
    try {
      const call = nativeCall(body);
      output += `${OPEN}${JSON.stringify({ name: call.name, arguments: call.arguments })}${end === -1 ? "" : CLOSE}`;
    } catch {
      output += `${OPEN}${body}`;
      if (end !== -1) output += CLOSE;
    }
    if (end === -1) break;
    cursor = end + found.protocol.close.length;
  }
  return output;
}

/** Extract the first balanced JSON object, including strings with raw newlines. */
function balancedObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return text.slice(start, index + 1);
  }
  return null;
}

/** Longest suffix of `text` that is a prefix of `tag` (for split streaming tags). */
function partialSuffix(text: string, tag: string): number {
  const max = Math.min(text.length, tag.length - 1);
  for (let length = max; length > 0; length--) {
    if (text.toLowerCase().endsWith(tag.slice(0, length))) return length;
  }
  return 0;
}

function findTag(text: string, tag: string): number {
  return text.toLowerCase().indexOf(tag);
}

/** A tag inside a JSON string is file content, not a protocol delimiter. */
function closingTag(text: string, from = 0): number {
  if (/^\s*<function=/.test(text.slice(from))) {
    // XML parameter bodies are raw file text, not JSON strings. Ignore their
    // literal </tool_call> tags and quotes while locating the protocol close.
    let cursor = from;
    for (;;) {
      const parameter = text.indexOf("<parameter=", cursor);
      const functionEnd = text.indexOf("</function>", cursor);
      if (functionEnd === -1) return -1;
      if (parameter !== -1 && parameter < functionEnd) {
        const end = text.indexOf("</parameter>", parameter);
        if (end === -1) return -1;
        cursor = end + "</parameter>".length;
      } else {
        const end = functionEnd + "</function>".length;
        const suffix = text.slice(end);
        const match = /^\s*<\/tool_call>/i.exec(suffix);
        return match ? end + match[0].length - CLOSE.length : -1;
      }
    }
  }
  let quoted = false;
  let escaped = false;
  for (let index = from; index < text.length; index++) {
    const char = text[index]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "<" && text.slice(index, index + CLOSE.length).toLowerCase() === CLOSE) return index;
  }
  return -1;
}

/**
 * Hides `<tool_call>...</tool_call>` blocks from the live text stream while
 * keeping partial tags buffered. The full raw text is parsed separately.
 */
export class ToolCallStreamFilter {
  private buffer = "";
  private suppressed = false;
  private quoted = false;
  private escaped = false;
  private closeTag = CLOSE;
  private bodyFormat: "pending" | "json" | "xml" = "pending";

  push(delta: string): string {
    this.buffer += delta;
    let out = "";
    for (;;) {
      if (this.suppressed) {
        if (this.bodyFormat === "pending") {
          const first = this.buffer.trimStart()[0];
          if (!first) return out;
          this.bodyFormat = first === "<" && this.closeTag === CLOSE ? "xml" : "json";
        }
        if (this.bodyFormat === "xml") {
          const end = closingTag(this.buffer);
          if (end === -1) return out;
          this.buffer = this.buffer.slice(end + CLOSE.length);
          this.suppressed = false;
          this.bodyFormat = "pending";
          continue;
        }
        let ended = false;
        for (let index = 0; index < this.buffer.length; index++) {
          const char = this.buffer[index]!;
          if (this.quoted) {
            if (this.escaped) this.escaped = false;
            else if (char === "\\") this.escaped = true;
            else if (char === '"') this.quoted = false;
          } else if (char === '"') this.quoted = true;
          else if (char === "<") {
            const candidate = this.buffer.slice(index, index + this.closeTag.length).toLowerCase();
            if (candidate === this.closeTag) {
              this.buffer = this.buffer.slice(index + this.closeTag.length);
              this.suppressed = false;
              ended = true;
              break;
            }
            if (this.closeTag.startsWith(candidate) && index + this.closeTag.length > this.buffer.length) {
              this.buffer = this.buffer.slice(index);
              return out;
            }
          }
        }
        if (!ended) { this.buffer = ""; return out; }
        continue;
      }

      const openings = [{ open: OPEN, close: CLOSE }, ...NATIVE_PROTOCOLS]
        .map((protocol) => ({ ...protocol, index: findTag(this.buffer, protocol.open) }))
        .filter((protocol) => protocol.index !== -1).sort((a, b) => a.index - b.index);
      const opening = openings[0];
      if (opening) {
        const start = opening.index;
        out += this.buffer.slice(0, start);
        this.buffer = this.buffer.slice(start + opening.open.length);
        this.suppressed = true;
        this.bodyFormat = "pending";
        this.closeTag = opening.close;
        this.quoted = false;
        this.escaped = false;
        continue;
      }

      const keep = Math.max(partialSuffix(this.buffer, OPEN), ...NATIVE_PROTOCOLS.map((protocol) => partialSuffix(this.buffer, protocol.open)));
      if (keep > 0) {
        out += this.buffer.slice(0, this.buffer.length - keep);
        this.buffer = this.buffer.slice(this.buffer.length - keep);
      } else {
        out += this.buffer;
        this.buffer = "";
      }
      return out;
    }
  }

  flush(): string {
    if (this.suppressed) {
      this.buffer = "";
      return "";
    }
    const out = this.buffer;
    this.buffer = "";
    return out;
  }

  get insideToolCall(): boolean {
    return this.suppressed;
  }
}

/** Parse text-protocol tool calls emitted by small models. */
export function parseToolCalls(raw: string, definitions: readonly Pick<ToolDefinition, "name" | "parameters">[] = []): ParsedToolCalls {
  raw = normalizeNativeToolCalls(raw);
  const calls: ParsedToolCall[] = [];
  const errors: string[] = [];
  const issues: ToolParseIssue[] = [];
  const bodies: string[] = [];
  const visible: string[] = [];
  let cursor = 0;
  while (cursor < raw.length) {
    const offset = findTag(raw.slice(cursor), OPEN);
    if (offset === -1) { visible.push(raw.slice(cursor)); break; }
    const start = cursor + offset;
    visible.push(raw.slice(cursor, start));
    const bodyStart = start + OPEN.length;
    const end = closingTag(raw, bodyStart);
    if (end !== -1) {
      bodies.push(raw.slice(bodyStart, end).trim());
      cursor = end + CLOSE.length;
    } else {
      const body = raw.slice(bodyStart).trim();
      const recovered = /^\s*<function=/.test(body) ? null : balancedObject(body);
      if (recovered) bodies.push(recovered);
      else {
        const fragment = body.slice(0, 500);
        const message = "A <tool_call> block was not closed and its JSON object is incomplete.";
        errors.push(message);
        issues.push({ message, fragment, kind: "incomplete", toolName: toolNameIn(fragment) });
      }
      break;
    }
  }

  for (const body of bodies) {
    if (!body) {
      errors.push("Empty tool call block.");
      issues.push({ message: "Empty tool call block.", fragment: body, kind: "empty" });
      continue;
    }
    try {
      const parsed = (/^\s*<function=/.test(body) ? parseXmlCall(body, definitions) : parseJsonObject(body)) as { name?: unknown; arguments?: unknown };
      if (!parsed || typeof parsed !== "object") throw new Error("expected a JSON object.");
      const name = parsed.name;
      if (typeof name !== "string" || !name.trim()) throw new Error('"name" must be a non-empty string.');

      let args: unknown = parsed.arguments ?? {};
      if (typeof args === "string") args = parseJsonObject(args);
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        throw new Error('"arguments" must be a JSON object.');
      }

      calls.push({
        name: name.trim(),
        arguments: args as Record<string, unknown>,
      });
    } catch (error) {
      const message = `Invalid tool call JSON: ${errorMessage(error)}`;
      errors.push(message);
      issues.push({ message, fragment: body.slice(0, 500), kind: "json", toolName: toolNameIn(body) });
    }
  }

  const text = visible.join("").trim();

  return { text, calls, errors, issues };
}
