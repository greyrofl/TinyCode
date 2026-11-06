import type { OpenAICompatibleProviderConfig } from "../config/config.js";
import type { Usage } from "../types.js";
import { sanitizeText } from "../../util/text.js";
import type { ChatOptions, ChatStreamEvent, HealthResult, ModelDetails, ModelInfo, Provider } from "./types.js";

interface OpenAIChunk {
  choices?: Array<{
    delta?: { content?: string; reasoning_content?: string; reasoning?: string; tool_calls?: Array<{ index?: number; function?: { name?: string; arguments?: string } }> };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: string | { message?: string };
}

export class OpenAICompatibleProvider implements Provider {
  readonly id: string;
  readonly name: string;
  private readonly baseUrl: string;
  constructor(id: string, private readonly config: OpenAICompatibleProviderConfig) {
    this.id = id; this.name = config.name; this.baseUrl = config.baseUrl.replace(/\/+$/, "");
  }

  private headers(): Record<string, string> {
    const key = this.config.apiKeyEnv ? process.env[this.config.apiKeyEnv]?.trim() : undefined;
    if (this.config.apiKeyEnv && !key) throw new Error(`${this.name} requires the ${this.config.apiKeyEnv} environment variable.`);
    return { "content-type": "application/json", ...this.config.headers, ...(key ? { authorization: `Bearer ${key}` } : {}) };
  }

  private signal(signal?: AbortSignal, timeout = this.config.timeoutMs): AbortSignal {
    const timer = AbortSignal.timeout(Math.max(1_000, timeout));
    return signal ? AbortSignal.any([signal, timer]) : timer;
  }

  async listModels(): Promise<ModelInfo[]> {
    return Object.entries(this.config.models).map(([id, model]) => ({
      id, name: model.name, parameterSize: model.parameterSize, quantization: model.quantization, family: model.family,
    })).sort((a, b) => a.name.localeCompare(b.name));
  }

  async getModelDetails(model: string): Promise<ModelDetails> {
    const configured = this.config.models[model];
    if (!configured) throw new Error(`Model ${model} is not declared in providers.${this.id}.models.`);
    const thinking = configured.thinking === false ? { modes: ["off"], defaultMode: "off", control: "none" as const }
      : { modes: configured.thinking.modes, defaultMode: configured.thinking.defaultMode, control: configured.thinking.field === "none" ? "none" as const : "native" as const, values: configured.thinking.values };
    return { id: model, name: configured.name, parameterSize: configured.parameterSize, quantization: configured.quantization,
      family: configured.family, contextLength: configured.contextLength, thinking };
  }

  async health(): Promise<HealthResult> {
    try {
      const response = await fetch(`${this.baseUrl}/models`, { headers: this.headers(), signal: this.signal(undefined, 5_000) });
      if (!response.ok) return { ok: false, error: `${this.name} /models returned HTTP ${response.status}.` };
      return { ok: true };
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  }

  async *chat(options: ChatOptions): AsyncIterable<ChatStreamEvent> {
    const model = this.config.models[options.model];
    if (!model) throw new Error(`Model ${options.model} is not declared for ${this.name}.`);
    const requested = Number(options.options?.num_predict);
    if (!Number.isFinite(requested) || requested < 1) throw new Error(`${this.name} requires a finite positive num_predict.`);
    const allowed = new Set(["temperature", "top_p", "top_k", "min_p", "repeat_penalty", "presence_penalty", "frequency_penalty", "seed", "stop"]);
    const body: Record<string, unknown> = {
      ...this.config.extraBody,
      ...Object.fromEntries(Object.entries(options.options ?? {}).filter(([key]) => allowed.has(key))),
      model: options.model,
      messages: options.messages,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: Math.floor(requested),
      ...(options.tools?.length ? { tools: options.tools, parallel_tool_calls: false } : {}),
    };
    if (model.thinking !== false && model.thinking.field !== "none" && options.think !== undefined) {
      const mode = options.think === false ? "off" : options.think === true ? "on" : String(options.think);
      const value = model.thinking.values[mode] ?? (mode === "off" ? "none" : mode === "on" ? "medium" : mode);
      body[model.thinking.field] = value;
    }
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST", headers: this.headers(), body: JSON.stringify(body), signal: this.signal(options.signal, options.timeoutMs),
    });
    if (!response.ok) {
      let detail = ""; try { detail = sanitizeText(await response.text()).slice(0, 600); } catch { /* status is enough */ }
      throw new Error(`${this.name} request failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`);
    }
    if (!response.body) throw new Error(`${this.name} returned an empty stream.`);
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = "", eventData: string[] = [], completed = false, stopReason: string | undefined;
    let usage: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    const nativeCalls = new Map<number, { name: string; arguments: string }>();
    const parseEvent = (): ChatStreamEvent[] => {
      if (!eventData.length) return [];
      const source = eventData.join("\n"); eventData = [];
      if (source.trim() === "[DONE]") { completed = true; return []; }
      let chunk: OpenAIChunk;
      try { chunk = JSON.parse(source) as OpenAIChunk; } catch { throw new Error(`Invalid ${this.name} SSE event: ${sanitizeText(source).slice(0, 200)}`); }
      if (chunk.error) throw new Error(typeof chunk.error === "string" ? chunk.error : chunk.error.message ?? `${this.name} stream failed.`);
      const events: ChatStreamEvent[] = [], choice = chunk.choices?.[0], delta = choice?.delta;
      if (delta?.reasoning_content || delta?.reasoning) events.push({ type: "reasoning", text: delta.reasoning_content || delta.reasoning! });
      if (delta?.content) events.push({ type: "text", text: delta.content });
      for (const call of delta?.tool_calls ?? []) {
        const current = nativeCalls.get(call.index ?? 0) ?? { name: "", arguments: "" };
        current.name += call.function?.name ?? ""; current.arguments += call.function?.arguments ?? "";
        nativeCalls.set(call.index ?? 0, current);
      }
      if (choice?.finish_reason) stopReason = choice.finish_reason;
      if (chunk.usage) usage = { promptTokens: chunk.usage.prompt_tokens ?? 0, completionTokens: chunk.usage.completion_tokens ?? 0,
        totalTokens: chunk.usage.total_tokens ?? (chunk.usage.prompt_tokens ?? 0) + (chunk.usage.completion_tokens ?? 0) };
      return events;
    };
    const line = (value: string): ChatStreamEvent[] => {
      if (!value) return parseEvent();
      if (value.startsWith("data:")) eventData.push(value.slice(5).trimStart());
      return [];
    };
    try {
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        if (buffer.length > 4_000_000) throw new Error(`${this.name} SSE line exceeded its limit.`);
        let newline = buffer.indexOf("\n");
        while (newline !== -1) { const source = buffer.slice(0, newline).replace(/\r$/, ""); buffer = buffer.slice(newline + 1); for (const event of line(source)) yield event; newline = buffer.indexOf("\n"); }
      }
      buffer += decoder.decode(); if (buffer) for (const event of line(buffer.replace(/\r$/, ""))) yield event;
      for (const event of parseEvent()) yield event;
      if (!completed) throw new Error(`${this.name} stream ended before [DONE]. Incomplete tool calls were not executed.`);
      for (const call of nativeCalls.values()) {
        const prefix = `<tool_call>{"name":${JSON.stringify(call.name)},"arguments":${call.arguments}`;
        let valid = false; try { const value = JSON.parse(call.arguments); valid = typeof value === "object" && value !== null && !Array.isArray(value); } catch { /* repaired by agent loop */ }
        yield { type: "text", text: valid ? `${prefix}}</tool_call>` : prefix };
      }
      yield { type: "done", usage, stopReason, outputLimit: Math.floor(requested) };
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
}
