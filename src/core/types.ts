export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  tokensPerSecond?: number;
}

export type StatusState =
  | "idle"
  | "compacting"
  | "connecting"
  | "thinking"
  | "responding"
  | "tool"
  | "evaluating"
  | "aborted"
  | "error";

export interface ChatStatus {
  state: StatusState;
  detail?: string;
}

export type NoticeLevel = "info" | "warn" | "error";

export interface ContextUsage {
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  maxTokens: number;
  percent: number;
  estimated: boolean;
}

export function mergeUsage(current: Usage | undefined, next: Usage | undefined): Usage | undefined {
  if (!current) return next;
  if (!next) return current;
  return {
    promptTokens: current.promptTokens + next.promptTokens,
    completionTokens: current.completionTokens + next.completionTokens,
    totalTokens: current.totalTokens + next.totalTokens,
    tokensPerSecond: next.tokensPerSecond ?? current.tokensPerSecond,
  };
}
