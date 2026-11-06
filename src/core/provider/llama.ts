import type { Usage } from "../types.js";
import { LlamaRuntime } from "../llama-runtime.js";
import type { ChatOptions, ChatStreamEvent, HealthResult, LoadModelOptions, ModelDetails, ModelInfo, Provider, RunningModelInfo } from "./types.js";
import { sanitizeText } from "../../util/text.js";

interface CompletionChunk {
  choices?: Array<{
    delta?: { content?: string; reasoning_content?: string; reasoning?: string; tool_calls?: Array<{ index?: number; function?: { name?: string; arguments?: string } }> };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  timings?: { prompt_n?: number; cache_n?: number; predicted_n?: number; predicted_per_second?: number };
  error?: string | { message?: string };
}

/** OpenAI-compatible SSE transport; the agent's existing text tool protocol stays intact. */
export class LlamaProvider implements Provider {
  readonly id = "llama.cpp";
  readonly name = "llama.cpp";
  private readonly details = new Map<string, ModelDetails>();
  constructor(readonly runtime: LlamaRuntime) {}

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const models = await this.runtime.catalog.list(signal);
    if (await this.runtime.available() && !this.runtime.owned) {
      try {
        const data = await (await this.runtime.request("/v1/models", undefined, signal, 10_000)).json() as { data?: Array<{ id: string; meta?: { size?: number; n_params?: number } }> };
        for (const model of data.data ?? []) if (!models.some((item) => item.id === model.id)) models.push({ id: model.id, name: model.id, sizeBytes: model.meta?.size });
      } catch {
        // A service on the configured external port must not hide local GGUFs.
      }
    }
    return models;
  }

  async health(): Promise<HealthResult> {
    try {
      if (await this.runtime.available()) {
        const props = await this.runtime.props();
        return { ok: true, version: typeof props.build_info === "string" ? props.build_info : undefined };
      }
      const installed = await this.runtime.installer.locate();
      return installed ? { ok: true, version: "installed; server starts on first prompt" }
        : { ok: false, error: this.runtime.config.autoInstall ? "llama-server will be installed on first model load (official binaries only)." : "llama-server not found; configure llama.executable." };
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  }

  private updateDetails(details: ModelDetails, props: Record<string, unknown>): void {
    const settings = props.default_generation_settings as { params?: Record<string, unknown> } | undefined;
    const params = settings?.params ?? {};
    const number = (key: string): number | undefined => typeof params[key] === "number" && Number.isFinite(params[key]) ? params[key] as number : undefined;
    if (Object.keys(params).length) details.samplingDefaults = {
      temperature: number("temperature"), topP: number("top_p"), topK: number("top_k"), minP: number("min_p"),
      repeatPenalty: number("repeat_penalty"), presencePenalty: number("presence_penalty"),
    };
    const caps = props.chat_template_caps as Record<string, unknown> | undefined;
    const levels = Array.isArray(caps?.reasoning_effort_levels) ? caps.reasoning_effort_levels.filter((level): level is string => typeof level === "string") : [];
    const template = String(props.chat_template ?? "");
    const toggle = caps?.supports_enable_thinking === true || /enable_thinking|enable_reasoning/.test(template);
    if (toggle || levels.length) {
      const modes = [...new Set([...(toggle ? ["off", "on"] : []), ...levels])];
      details.thinking = { modes, defaultMode: toggle ? "off" : modes[0]!, control: "native" };
    }
  }

  async getModelDetails(model: string): Promise<ModelDetails> {
    const cached = this.details.get(model);
    if (cached) return cached;
    let details: ModelDetails;
    try { details = await this.runtime.catalog.getDetails(model); }
    catch (error) {
      const running = await this.runtime.getRunningModel(model);
      if (!running) throw error;
      const models = await (await this.runtime.request("/v1/models", undefined, undefined, 10_000)).json() as { data?: Array<{ meta?: { n_ctx_train?: number; size?: number } }> };
      details = { id: model, name: model, sizeBytes: models.data?.[0]?.meta?.size,
        contextLength: models.data?.[0]?.meta?.n_ctx_train ?? running.contextLength,
        thinking: { modes: ["off"], defaultMode: "off", control: "none" } };
      this.updateDetails(details, await this.runtime.props());
    }
    this.details.set(model, details);
    return details;
  }

  getRunningModel(model: string, signal?: AbortSignal): Promise<RunningModelInfo | null> { return this.runtime.getRunningModel(model, signal); }
  unloadModel(model: string, signal?: AbortSignal): Promise<RunningModelInfo | null> { return this.runtime.unloadModel(model, signal); }
  async loadModel(options: LoadModelOptions): Promise<RunningModelInfo> {
    const result = await this.runtime.loadModel(options);
    this.updateDetails(await this.getModelDetails(options.model), await this.runtime.props(options.signal));
    return result;
  }

  async *chat(options: ChatOptions): AsyncIterable<ChatStreamEvent> {
    const ctx = Number(options.options?.num_ctx);
    const predict = Number(options.options?.num_predict);
    if (!Number.isInteger(ctx) || ctx < 256 || !Number.isFinite(predict) || predict < 1) throw new Error("llama.cpp generation needs explicit finite num_ctx and num_predict. No history was discarded.");
    const running = await this.loadModel({ model: options.model, numCtx: ctx, signal: options.signal });
    if (running.contextLength !== ctx) throw new Error("llama.cpp context differs from the selected budget; apply /context before generating.");
    const allowed = new Set(["temperature", "top_p", "top_k", "min_p", "repeat_penalty", "presence_penalty", "frequency_penalty", "seed", "stop", "repeat_last_n", "dry_multiplier", "dry_base", "dry_allowed_length"]);
    const sampling = Object.fromEntries(Object.entries(options.options ?? {}).filter(([key]) => allowed.has(key)));
    const thinking: Record<string, unknown> = options.think === false
      ? { chat_template_kwargs: { enable_thinking: false, enable_reasoning: false }, reasoning_effort: "none" }
      : options.think === true ? { chat_template_kwargs: { enable_thinking: true, enable_reasoning: true } }
        : typeof options.think === "string" ? { reasoning_effort: options.think } : {};
    // Count the whole templated history with this model's own tokenizer, never trim it.
    const template = await (await this.runtime.request("/apply-template", { messages: options.messages, ...thinking }, options.signal, options.timeoutMs)).json() as { prompt?: string };
    if (typeof template.prompt !== "string") throw new Error("llama.cpp /apply-template did not return a prompt. No generation was sent.");
    const tokens = await (await this.runtime.request("/tokenize", { content: template.prompt, add_special: true, parse_special: true }, options.signal, options.timeoutMs)).json() as { tokens?: unknown[] };
    if (!Array.isArray(tokens.tokens)) throw new Error("llama.cpp /tokenize did not return token counts. No generation was sent.");
    const available = ctx - tokens.tokens.length - 8;
    if (available < 1) throw new Error(`Full history requires ${tokens.tokens.length} prompt tokens in a ${ctx}-token llama.cpp window. Use /compact or a larger /context; no messages were omitted.`);
    const outputLimit = Math.floor(Math.min(predict, available));
    const response = await this.runtime.request("/v1/chat/completions", {
      ...sampling, ...thinking, model: this.runtime.apiModel || options.model, messages: options.messages,
      stream: true, stream_options: { include_usage: true }, max_tokens: outputLimit,
      cache_prompt: true, n_keep: -1, context_shift: false, reasoning_format: "deepseek",
      ...(options.tools?.length ? { tools: options.tools, parallel_tool_calls: false } : {}),
    }, options.signal, options.timeoutMs);
    if (!response.body) throw new Error("llama.cpp returned an empty stream.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "", data: string[] = [], completed = false, stopReason: string | undefined;
    let usage: Usage = { promptTokens: tokens.tokens.length, completionTokens: 0, totalTokens: tokens.tokens.length };
    const nativeCalls = new Map<number, { name: string; arguments: string }>();
    function parseEvent(): ChatStreamEvent[] {
      if (!data.length) return [];
      const source = data.join("\n"); data = [];
      if (source.trim() === "[DONE]") { completed = true; return []; }
      let raw: CompletionChunk;
      try { raw = JSON.parse(source) as CompletionChunk; } catch { throw new Error(`Invalid llama.cpp SSE event: ${sanitizeText(source).slice(0, 200)}`); }
      if (raw.error) throw new Error(typeof raw.error === "string" ? raw.error : raw.error.message ?? "llama.cpp stream failed.");
      const events: ChatStreamEvent[] = [];
      const choice = raw.choices?.[0];
      const delta = choice?.delta;
      if (delta?.reasoning_content || delta?.reasoning) events.push({ type: "reasoning", text: delta.reasoning_content || delta.reasoning! });
      if (delta?.content) events.push({ type: "text", text: delta.content });
      for (const call of delta?.tool_calls ?? []) {
        const current = nativeCalls.get(call.index ?? 0) ?? { name: "", arguments: "" };
        current.name += call.function?.name ?? ""; current.arguments += call.function?.arguments ?? "";
        nativeCalls.set(call.index ?? 0, current);
      }
      if (choice?.finish_reason) stopReason = choice.finish_reason;
      const promptTokens = raw.usage?.prompt_tokens ?? (raw.timings?.prompt_n !== undefined ? raw.timings.prompt_n + (raw.timings.cache_n ?? 0) : usage.promptTokens);
      const completionTokens = raw.usage?.completion_tokens ?? raw.timings?.predicted_n ?? usage.completionTokens;
      usage = { ...usage, promptTokens, completionTokens, totalTokens: raw.usage?.total_tokens ?? promptTokens + completionTokens,
        ...(raw.timings?.predicted_per_second ? { tokensPerSecond: raw.timings.predicted_per_second } : {}) };
      return events;
    }
    function line(source: string): ChatStreamEvent[] {
      if (!source) return parseEvent();
      if (source.startsWith("data:")) data.push(source.slice(5).trimStart());
      return [];
    }
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        if (buffer.length > 4_000_000) throw new Error("llama.cpp SSE line exceeded its limit.");
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          const source = buffer.slice(0, newline).replace(/\r$/, ""); buffer = buffer.slice(newline + 1);
          for (const event of line(source)) yield event;
          newline = buffer.indexOf("\n");
        }
      }
      buffer += decoder.decode();
      if (buffer) for (const event of line(buffer.replace(/\r$/, ""))) yield event;
      for (const event of parseEvent()) yield event;
      if (!completed) throw new Error("llama.cpp stream ended before its [DONE] marker. Incomplete tool calls were not executed.");
      for (const call of nativeCalls.values()) {
        // Some model parsers return native tool deltas even without a tools schema.
        // Reconstruct the existing protocol; validation/approval still happens in TinyCode.
        const prefix = `<tool_call>{"name":${JSON.stringify(call.name)},"arguments":${call.arguments}`;
        let valid = false;
        try { const value = JSON.parse(call.arguments); valid = typeof value === "object" && value !== null && !Array.isArray(value); } catch { /* Preserve truncated fragment for repair. */ }
        yield { type: "text", text: valid ? `${prefix}}</tool_call>` : prefix };
      }
      yield { type: "done", usage, stopReason, outputLimit };
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
}
