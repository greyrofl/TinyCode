import { errorMessage } from "../util/errors.js";

const OPEN = "<tool_call>";
const CLOSE = "</tool_call>";

export interface ParsedToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ParsedToolCalls {
  /** Assistant text with tool-call blocks removed. */
  text: string;
  calls: ParsedToolCall[];
  errors: string[];
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
  return out.replace(/,\s*([}\]])/g, "$1");
}

function parseJsonObject(text: string): Record<string, unknown> {
  const clean = stripFence(text);
  try {
    return JSON.parse(clean) as Record<string, unknown>;
  } catch {
    return JSON.parse(repairJson(clean)) as Record<string, unknown>;
  }
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

/**
 * Hides `<tool_call>...</tool_call>` blocks from the live text stream while
 * keeping partial tags buffered. The full raw text is parsed separately.
 */
export class ToolCallStreamFilter {
  private buffer = "";
  private suppressed = false;

  push(delta: string): string {
    this.buffer += delta;
    let out = "";
    for (;;) {
      if (this.suppressed) {
        const end = findTag(this.buffer, CLOSE);
        if (end === -1) {
          const keep = partialSuffix(this.buffer, CLOSE);
          this.buffer = keep > 0 ? this.buffer.slice(-keep) : "";
          return out;
        }
        this.buffer = this.buffer.slice(end + CLOSE.length);
        this.suppressed = false;
        continue;
      }

      const start = findTag(this.buffer, OPEN);
      if (start !== -1) {
        out += this.buffer.slice(0, start);
        this.buffer = this.buffer.slice(start + OPEN.length);
        this.suppressed = true;
        continue;
      }

      const keep = partialSuffix(this.buffer, OPEN);
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
export function parseToolCalls(raw: string): ParsedToolCalls {
  const calls: ParsedToolCall[] = [];
  const errors: string[] = [];
  const pattern = /<tool_call>([\s\S]*?)<\/tool_call>/gi;

  const bodies = [...raw.matchAll(pattern)].map((match) => match[1]!.trim());
  const opens = (raw.match(/<tool_call>/gi) ?? []).length;
  const closes = (raw.match(/<\/tool_call>/gi) ?? []).length;
  if (opens > closes) {
    const start = raw.toLowerCase().lastIndexOf("<tool_call>");
    const recovered = balancedObject(raw.slice(start + OPEN.length));
    if (recovered) bodies.push(recovered);
    else errors.push("A <tool_call> block was not closed and its JSON object is incomplete.");
  }

  for (const body of bodies) {
    if (!body) {
      errors.push("Empty tool call block.");
      continue;
    }
    try {
      const parsed = parseJsonObject(body) as { name?: unknown; arguments?: unknown };
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
      errors.push(
        `Invalid tool call JSON. Use one-line JSON and encode newlines as \\n: ${errorMessage(error)}`,
      );
    }
  }

  const text = raw
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "")
    .replace(/<tool_call>[\s\S]*$/i, "")
    .trim();

  return { text, calls, errors };
}
