import type { Usage } from "../types.js";

/** auto uses the model default; named levels must come from /api/show. */
export type ThinkingMode = string;

export interface ModelDetails extends ModelInfo {
  contextLength?: number;
  samplingDefaults?: {
    temperature?: number;
    topP?: number;
    topK?: number;
    minP?: number;
    repeatPenalty?: number;
    presencePenalty?: number;
  };
  thinking: {
    modes: ThinkingMode[];
    defaultMode: ThinkingMode;
    control: "native" | "prompt" | "none";
    note?: string;
    values?: Record<string, boolean | string>;
  };
}

export interface ModelInfo {
  id: string;
  name: string;
  parameterSize?: string;
  quantization?: string;
  family?: string;
  sizeBytes?: number;
  modifiedAt?: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  model: string;
  messages: ChatMessage[];
  signal?: AbortSignal;
  timeoutMs?: number;
  think?: boolean | string;
  options?: Record<string, unknown>;
  keepAlive?: string;
}

export type ChatStreamEvent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "done"; usage: Usage; stopReason?: string }
  | { type: "error"; error: Error };

export interface HealthResult {
  ok: boolean;
  version?: string;
  error?: string;
}

/**
 * The only seam the chat loop needs. Adding another local runtime later means
 * implementing this interface and registering it, without touching the UI.
 */
export interface Provider {
  readonly id: string;
  readonly name: string;
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
  getModelDetails?(model: string): Promise<ModelDetails>;
  chat(options: ChatOptions): AsyncIterable<ChatStreamEvent>;
  health(): Promise<HealthResult>;
}
