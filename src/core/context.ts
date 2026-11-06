import type { ChatMessage } from "./provider/types.js";
import type { Message, ToolPart } from "./session/types.js";
import { textOf } from "./session/types.js";

export interface ContextOptions {
  /** Legacy setting; history is no longer selected by message count. */
  maxMessages: number;
  /** Optional explicit character budget; zero disables this legacy bound. */
  maxChars: number;
  /** Input token budget, including the system prompt. */
  maxTokens?: number;
}

function observationFor(part: ToolPart): string {
  const value = part.output ?? part.error ?? "(no output)";
  switch (part.status) {
    case "completed":
      return `[Observation: ${value}]`;
    case "denied":
      return `[Observation: Tool call denied by the user: ${part.error ?? "permission denied"}]`;
    case "error":
      return `[Observation: Error: ${value}]`;
    default:
      return "[Observation: Tool call did not finish.]";
  }
}

/**
 * Reconstruct the text-protocol conversation, including tool calls and their
 * observations. Reasoning is intentionally not sent back to the model.
 */
function expandMessage(message: Message): ChatMessage[] {
  if (message.role === "user") {
    const text = textOf(message).trim();
    return text ? [{ role: "user", content: text }] : [];
  }

  const out: ChatMessage[] = [];
  let buffer = "";

  const flush = (): void => {
    if (buffer.trim()) out.push({ role: "assistant", content: buffer.trim() });
    buffer = "";
  };

  for (const part of message.parts) {
    if (part.type === "text") {
      buffer += (buffer ? "\n" : "") + part.text;
    } else if (part.type === "steering") {
      flush();
      if (part.text.trim()) out.push({ role: "user", content: part.text.trim() });
    } else if (part.type === "goal_review") {
      flush();
      if (part.verdict === "continue") out.push({ role: "user", content: `[Goal evaluator — continue_work]\n${part.text.trim()}` });
    } else if (part.type === "tool") {
      if (!part.synthetic) {
        const call = `<tool_call>${JSON.stringify({ name: part.tool, arguments: part.input })}</tool_call>`;
        buffer += (buffer ? "\n" : "") + call;
      }
      flush();
      out.push({ role: "user", content: observationFor(part) });
    }
  }
  if (message.error) buffer += `\n[Previous turn error: ${message.error}]`;
  if (message.aborted) buffer += "\n[Previous turn was aborted; unfinished actions are not completed.]";
  flush();
  return out;
}

function mergeConsecutive(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const message of messages) {
    const last = out[out.length - 1];
    if (last && last.role === message.role && message.role !== "system") {
      last.content += `\n\n${message.content}`;
    } else {
      out.push({ ...message });
    }
  }
  return out;
}

/** Approximate input tokens, accounting for UTF-8 text and message framing. */
export function estimateContextTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, message) => sum + Math.ceil(Buffer.byteLength(message.content, "utf8") / 4) + 8, 3);
}

export class ContextOverflowError extends Error {
  constructor(detail: string) {
    super(`History exceeds the selected context budget (${detail}). No messages were discarded. Enable automatic compaction, use /compact or a larger /context, reduce generation.numPredict, or request a smaller tool output.`);
    this.name = "ContextOverflowError";
  }
}

/**
 * Reconstruct all uncompacted history without selection or truncation.
 * Raw reasoning stays in the transcript, not in model input.
 */
export function expandContext(
  messages: Message[],
  systemPrompt?: string,
): ChatMessage[] {
  const out: ChatMessage[] = [];
  if (systemPrompt?.trim()) out.push({ role: "system", content: systemPrompt.trim() });

  for (const message of messages) out.push(...expandMessage(message));
  return mergeConsecutive(out);
}

/** Refuse overflow rather than silently omitting any part of the conversation. */
export function buildContext(
  messages: Message[],
  options: ContextOptions,
  systemPrompt?: string,
): ChatMessage[] {
  const out = expandContext(messages, systemPrompt);
  const bodyChars = out.filter((message) => message.role !== "system").reduce((sum, message) => sum + message.content.length, 0);
  if (options.maxChars > 0 && bodyChars > options.maxChars) {
    throw new ContextOverflowError(`${bodyChars} characters > ${options.maxChars}`);
  }
  const tokens = estimateContextTokens(out);
  if (options.maxTokens !== undefined && tokens > options.maxTokens) {
    throw new ContextOverflowError(`approximately ${tokens} input tokens > ${Math.max(0, options.maxTokens)}`);
  }
  return out;
}
