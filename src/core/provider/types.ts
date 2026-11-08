import type { Usage } from "../types.js";
import type { InferenceRuntimeOptions } from "../inference-profile.js";

/** auto uses the model default; named levels must come from provider/template metadata. */
export type ThinkingMode = string;

export interface ModelDetails extends ModelInfo {
  contextLength?: number;
  contextMemory?: {
    /** Incremental KV bytes for one token across one context slot. */
    variableKvBytesPerToken?: number;
    /** Fixed/capped sliding-window KV estimate. */
    fixedKvBytes?: number;
    confidence: "metadata" | "heuristic";
  };
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
  /** Draft sidecars are discoverable for inference setup, not main model selection. */
  role?: "target" | "draft";
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
  /** Managed local-runtime startup profile; remote providers may ignore it. */
  inference?: InferenceRuntimeOptions;
  tools?: Array<{
    type: "function";
    function: { name: string; description: string; parameters: Record<string, unknown> };
  }>;
}

export interface RunningModelInfo {
  id: string;
  sizeBytes: number;
  sizeVramBytes: number;
  contextLength: number;
  /** False when an external server does not expose physical allocation telemetry. */
  memoryKnown?: boolean;
  inferenceProfile?: InferenceRuntimeOptions["profile"];
}

export interface LoadModelOptions {
  model: string;
  numCtx: number;
  keepAlive?: string;
  runnerOptions?: Record<string, unknown>;
  inference?: InferenceRuntimeOptions;
  signal?: AbortSignal;
}

export type ChatStreamEvent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "done"; usage: Usage; stopReason?: string; outputLimit?: number }
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
  listDraftModels?(signal?: AbortSignal): Promise<ModelInfo[]>;
  getModelDetails?(model: string): Promise<ModelDetails>;
  getRunningModel?(model: string, signal?: AbortSignal): Promise<RunningModelInfo | null>;
  loadModel?(options: LoadModelOptions): Promise<RunningModelInfo | null>;
  unloadModel?(model: string, signal?: AbortSignal): Promise<RunningModelInfo | null>;
  chat(options: ChatOptions): AsyncIterable<ChatStreamEvent>;
  health(): Promise<HealthResult>;
  /** Optional multi-engine facade; ordinary providers remain usable in isolation. */
  listProviders?(): Array<{ id: string; name: string }>;
  selectProvider?(id: string): Promise<void>;
  listProviderModels?(signal?: AbortSignal): Promise<Array<{ provider: { id: string; name: string }; models: ModelInfo[]; error?: string }>>;
  getProviderModelDetails?(provider: string, model: string): Promise<ModelDetails>;
  prepareProviderModel?(provider: string, options: LoadModelOptions): Promise<void>;
  chatWithProvider?(provider: string, options: ChatOptions): AsyncIterable<ChatStreamEvent>;
}
