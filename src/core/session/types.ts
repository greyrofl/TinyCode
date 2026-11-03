import type { Usage } from "../types.js";

export type Role = "user" | "assistant";

export interface TextPart {
  type: "text";
  text: string;
}

export interface ReasoningPart {
  type: "reasoning";
  text: string;
}

export type ToolStatus = "pending" | "running" | "completed" | "error" | "denied";

export interface ToolPart {
  type: "tool";
  callId: string;
  tool: string;
  input: Record<string, unknown>;
  status: ToolStatus;
  title?: string;
  output?: string;
  error?: string;
  /** Internal parts (for example invalid tool calls) have no provider call. */
  synthetic?: boolean;
  changed?: boolean;
  changedPaths?: string[];
  verification?: boolean;
  startedAt?: number;
  endedAt?: number;
}

export type Part = TextPart | ReasoningPart | ToolPart;

export interface Message {
  id: string;
  role: Role;
  createdAt: number;
  model?: string;
  parts: Part[];
  error?: string;
  aborted?: boolean;
  usage?: Usage;
  outcome?: "completed" | "blocked" | "incomplete";
}

export interface SessionMeta {
  id: string;
  title: string;
  model: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  compaction?: SessionCompaction;
  thinking?: string;
  numCtx?: number;
  lastContext?: { inputTokens: number; generatedTokens: number; estimatedTokens: number; at: number };
}

export interface SessionCompaction {
  summary: string;
  throughMessageId: string;
  throughCreatedAt: number;
  sourceMessageCount: number;
  updatedAt: number;
  model: string;
  strategy: "model" | "fallback";
}

export interface Session {
  meta: SessionMeta;
  messages: Message[];
}

export function textOf(message: Message): string {
  return message.parts
    .filter((part): part is TextPart => part.type === "text")
    .map((part) => part.text)
    .join("");
}

export function reasoningOf(message: Message): string {
  return message.parts
    .filter((part): part is ReasoningPart => part.type === "reasoning")
    .map((part) => part.text)
    .join("");
}

/** Cheap change detector used by the transcript cache. */
export function messageVersion(message: Message): string {
  const parts = message.parts
    .map((part) => {
      if (part.type === "tool") {
        return `tool:${part.tool}:${part.status}:${part.output?.length ?? 0}:${part.error?.length ?? 0}`;
      }
      return `${part.type}:${part.text.length}`;
    })
    .join(",");
  return `${parts}|${message.outcome ?? ""}|${message.error ?? ""}|${message.aborted ? "1" : "0"}|${message.usage ? "u" : ""}|${
    message.model ?? ""
  }`;
}

export function toolPartsOf(message: Message): ToolPart[] {
  return message.parts.filter((part): part is ToolPart => part.type === "tool");
}
