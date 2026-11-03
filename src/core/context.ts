import type { ChatMessage } from "./provider/types.js";
import type { Message, ToolPart } from "./session/types.js";
import { textOf, toolPartsOf } from "./session/types.js";

export interface ContextOptions {
  maxMessages: number;
  maxChars: number;
}

function messageSize(message: Message): number {
  let size = textOf(message).length;
  for (const part of message.parts) {
    if (part.type !== "tool") continue;
    size += JSON.stringify(part.input).length;
    size += part.output?.length ?? 0;
    size += part.error?.length ?? 0;
  }
  return size;
}

function selectMessages(messages: Message[], options: ContextOptions): Message[] {
  const candidates = messages.filter(
    (message) =>
      !message.error &&
      !message.aborted &&
      (textOf(message).trim().length > 0 || toolPartsOf(message).length > 0),
  );

  let lastUser = -1;
  for (let index = 0; index < candidates.length; index++) {
    if (candidates[index]!.role === "user") lastUser = index;
  }

  let start = candidates.length;
  let characters = 0;
  for (let index = candidates.length - 1; index >= 0; index--) {
    const message = candidates[index]!;
    const selected = candidates.length - start;
    const size = messageSize(message);
    if (start < candidates.length && (selected >= options.maxMessages || characters + size > options.maxChars)) {
      break;
    }
    start = index;
    characters += size;
  }

  // Always keep the newest user turn, even if an agent loop made it long.
  if (lastUser >= 0) start = Math.min(start, lastUser);
  return candidates.slice(start);
}

function observationFor(part: ToolPart): string {
  switch (part.status) {
    case "completed":
      return `[Observation: ${part.output ?? "(no output)"}]`;
    case "denied":
      return `[Observation: Tool call denied by the user: ${part.error ?? "permission denied"}]`;
    case "error":
      return `[Observation: Error: ${part.error ?? part.output ?? "tool failed"}]`;
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
    } else if (part.type === "tool") {
      if (!part.synthetic) {
        const call = `<tool_call>${JSON.stringify({ name: part.tool, arguments: part.input })}</tool_call>`;
        buffer += (buffer ? "\n" : "") + call;
      }
      flush();
      out.push({ role: "user", content: observationFor(part) });
    }
  }
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

function truncateContent(content: string, max: number): string {
  if (content.length <= max) return content;
  if (max <= 40) return content.slice(0, Math.max(0, max));
  return `${content.slice(0, max - 30)}\n… context entry truncated`;
}

/** Keep the current user request plus the newest agent/tool exchange. */
function trimExpanded(messages: ChatMessage[], maxChars: number): ChatMessage[] {
  const system = messages.filter((message) => message.role === "system");
  const body = messages.filter((message) => message.role !== "system");
  const total = body.reduce((sum, message) => sum + message.content.length, 0);
  if (total <= maxChars || body.length === 0) return messages;

  const first = { ...body[0]! };
  const firstBudget = Math.max(256, Math.floor(maxChars * 0.4));
  first.content = truncateContent(first.content, firstBudget);
  let remaining = Math.max(0, maxChars - first.content.length);
  const tail: ChatMessage[] = [];

  for (let index = body.length - 1; index >= 1 && remaining > 0; index--) {
    const message = body[index]!;
    const content = truncateContent(message.content, remaining);
    tail.unshift({ ...message, content });
    remaining -= content.length;
  }

  return [...system, first, ...tail];
}

/**
 * Build the Ollama message list. The system prompt is injected by the caller;
 * no prompt is invented here. Small-model context trimming stays in this
 * module so every frontend gets the same behaviour.
 */
export function buildContext(
  messages: Message[],
  options: ContextOptions,
  systemPrompt?: string,
): ChatMessage[] {
  const out: ChatMessage[] = [];
  if (systemPrompt?.trim()) out.push({ role: "system", content: systemPrompt.trim() });

  for (const message of selectMessages(messages, options)) {
    out.push(...expandMessage(message));
  }

  const firstConversationIndex = out[0]?.role === "system" ? 1 : 0;
  while (out[firstConversationIndex]?.role === "assistant") {
    out.splice(firstConversationIndex, 1);
  }
  return mergeConsecutive(trimExpanded(out, options.maxChars));
}
