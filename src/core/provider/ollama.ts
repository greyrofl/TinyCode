import { isAbortError, isTimeoutError } from "../../util/errors.js";
import { sanitizeText } from "../../util/text.js";
import type { Usage } from "../types.js";
import type { ChatOptions, ChatStreamEvent, HealthResult, LoadModelOptions, ModelDetails, ModelInfo, Provider, RunningModelInfo } from "./types.js";
import { parseModelDetails, qwenNonThinkingPrompt } from "./model-details.js";

export interface OllamaConfig {
  baseUrl: string;
  timeoutMs: number;
  keepAlive?: string;
  headers?: Record<string, string>;
}

interface OllamaTagsResponse {
  models?: Array<{
    name?: string;
    model?: string;
    modified_at?: string;
    size?: number;
    details?: {
      family?: string;
      parameter_size?: string;
      quantization_level?: string;
    };
  }>;
}

interface OllamaChunk {
  message?: { content?: unknown; thinking?: unknown };
  response?: string;
  thinking?: string;
  done?: boolean;
  done_reason?: string;
  error?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  eval_duration?: number;
}

interface OllamaProcessesResponse {
  models?: Array<{ name?: string; model?: string; size?: number; size_vram?: number; context_length?: number }>;
}

interface ParsedChunk {
  content?: string;
  thinking?: string;
  done?: boolean;
  stopReason?: string;
  usage?: Usage;
  error?: string;
}

const CONNECTION_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ECONNRESET", "EHOSTUNREACH", "ETIMEDOUT"]);

function findErrorCode(error: unknown, depth = 0): string | undefined {
  if (!error || typeof error !== "object" || depth > 4) return undefined;
  if ("code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  if ("cause" in error) return findErrorCode((error as { cause?: unknown }).cause, depth + 1);
  return undefined;
}

function parseChunk(line: string): ParsedChunk {
  let raw: OllamaChunk;
  try {
    raw = JSON.parse(line) as OllamaChunk;
  } catch {
    throw new Error(`Unexpected response from Ollama: ${sanitizeText(line).slice(0, 200)}`);
  }

  if (typeof raw.error === "string") return { error: raw.error };

  const content = typeof raw.message?.content === "string" ? raw.message.content : raw.response;
  const thinking = typeof raw.message?.thinking === "string" ? raw.message.thinking : raw.thinking;
  const done = raw.done === true;

  let usage: Usage | undefined;
  if (done) {
    const promptTokens = typeof raw.prompt_eval_count === "number" ? raw.prompt_eval_count : 0;
    const completionTokens = typeof raw.eval_count === "number" ? raw.eval_count : 0;
    const durationNs = typeof raw.eval_duration === "number" ? raw.eval_duration : 0;
    usage = {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    };
    if (durationNs > 0 && completionTokens > 0) {
      usage.tokensPerSecond = completionTokens / (durationNs / 1e9);
    }
  }

  return { content, thinking, done, stopReason: raw.done_reason, usage };
}

async function describeHttpError(response: Response): Promise<string> {
  let detail = "";
  try {
    const text = (await response.text()).trim();
    if (text) {
      try {
        const parsed = JSON.parse(text) as { error?: unknown };
        detail = typeof parsed.error === "string" ? parsed.error : text;
      } catch {
        detail = text;
      }
    }
  } catch {
    // Ignore body read failures, the status code is still useful.
  }
  detail = sanitizeText(detail).replace(/\s+/g, " ").slice(0, 400);
  const prefix = `Ollama request failed (HTTP ${response.status})`;
  let message = detail ? `${prefix}: ${detail}` : prefix;
  if (/model .* not found/i.test(detail)) {
    message += " — pull it with: ollama pull <model>";
  }
  return message;
}

/**
 * Ollama provider. Model setup also uses empty /api/generate and /api/ps;
 * neither endpoint generates text or changes persistent server settings.
 * Streaming is newline-delimited JSON; reasoning-capable models expose their
 * thoughts in message.thinking, which we surface as a separate stream event.
 */
export class OllamaProvider implements Provider {
  readonly id = "ollama";
  readonly name = "Ollama";

  private readonly baseUrl: string;
  private readonly detailsCache = new Map<string, ModelDetails>();

  constructor(private readonly config: OllamaConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      ...this.config.headers,
    };
  }

  private requestSignal(signal?: AbortSignal, timeoutMs = this.config.timeoutMs): AbortSignal {
    const timeout = AbortSignal.timeout(Math.max(1_000, timeoutMs));
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
  }

  private describe(error: unknown, timeoutMs = this.config.timeoutMs): Error {
    if (isAbortError(error)) return error;
    if (isTimeoutError(error)) {
      return new Error(
        `Ollama did not respond within ${Math.round(timeoutMs / 1000)}s. The model may still be loading; ` +
          `try a smaller model or raise ollama.timeoutMs in the config.`,
      );
    }
    const code = findErrorCode(error);
    if (code && CONNECTION_CODES.has(code)) {
      return new Error(`Cannot reach Ollama at ${this.baseUrl}. Is the server running? Try: ollama serve (${code})`);
    }
    if (error instanceof Error && error.message === "fetch failed") {
      return new Error(
        `Cannot reach Ollama at ${this.baseUrl}. Is the server running? Start it with: ollama serve`,
      );
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/tags`, {
        headers: this.headers(),
        signal: this.requestSignal(signal, Math.min(this.config.timeoutMs, 15_000)),
      });
    } catch (error) {
      throw this.describe(error, Math.min(this.config.timeoutMs, 15_000));
    }
    if (!response.ok) throw new Error(await describeHttpError(response));

    const data = (await response.json()) as OllamaTagsResponse;
    return (data.models ?? [])
      .map((model): ModelInfo => {
        const id = model.name ?? model.model ?? "unknown";
        return {
          id,
          name: id,
          parameterSize: model.details?.parameter_size,
          quantization: model.details?.quantization_level,
          family: model.details?.family,
          sizeBytes: model.size,
          modifiedAt: model.modified_at,
        };
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async health(): Promise<HealthResult> {
    try {
      const response = await fetch(`${this.baseUrl}/api/version`, {
        signal: this.requestSignal(undefined, Math.min(this.config.timeoutMs, 5_000)),
      });
      if (!response.ok) return { ok: false, error: await describeHttpError(response) };
      const data = (await response.json()) as { version?: string };
      return { ok: true, version: data.version };
    } catch (error) {
      return { ok: false, error: this.describe(error, Math.min(this.config.timeoutMs, 5_000)).message };
    }
  }

  async getModelDetails(model: string): Promise<ModelDetails> {
    const cached = this.detailsCache.get(model);
    if (cached) return cached;
    const response = await fetch(`${this.baseUrl}/api/show`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ model }),
      signal: this.requestSignal(undefined, 15_000),
    });
    if (!response.ok) throw new Error(await describeHttpError(response));
    const details = parseModelDetails(model, await response.json() as Record<string, unknown>);
    this.detailsCache.set(model, details);
    return details;
  }

  private async runningModels(signal?: AbortSignal): Promise<RunningModelInfo[]> {
    const response = await fetch(`${this.baseUrl}/api/ps`, {
      headers: this.headers(),
      signal: this.requestSignal(signal, Math.min(this.config.timeoutMs, 10_000)),
    });
    if (!response.ok) throw new Error(await describeHttpError(response));
    const data = await response.json() as OllamaProcessesResponse;
    return (data.models ?? []).flatMap((item) => {
      const id = item.name ?? item.model;
      return id && typeof item.size === "number" && typeof item.size_vram === "number" && typeof item.context_length === "number"
        ? [{ id, sizeBytes: item.size, sizeVramBytes: item.size_vram, contextLength: item.context_length }]
        : [];
    });
  }

  async getRunningModel(model: string, signal?: AbortSignal): Promise<RunningModelInfo | null> {
    const normalize = (id: string): string => {
      const suffix = id.split("/").at(-1) ?? id;
      return `${id}${suffix.includes(":") ? "" : ":latest"}`.toLowerCase();
    };
    return (await this.runningModels(signal)).find((item) => normalize(item.id) === normalize(model)) ?? null;
  }

  async loadModel(options: LoadModelOptions): Promise<RunningModelInfo | null> {
    if (!Number.isInteger(options.numCtx) || options.numCtx < 256) throw new Error("Model loading requires a valid explicit context size.");
    const response = await fetch(`${this.baseUrl}/api/generate`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        model: options.model,
        prompt: "",
        stream: false,
        shift: false,
        truncate: false,
        ...(options.keepAlive ? { keep_alive: options.keepAlive } : {}),
        options: { ...options.runnerOptions, num_ctx: options.numCtx },
      }),
      signal: this.requestSignal(options.signal, this.config.timeoutMs),
    });
    if (!response.ok) throw new Error(await describeHttpError(response));
    await response.json();
    return this.getRunningModel(options.model, options.signal);
  }

  /** Expire only this model, then wait until the scheduler removes its runner. */
  async unloadModel(model: string, signal?: AbortSignal): Promise<RunningModelInfo | null> {
    const before = await this.getRunningModel(model, signal);
    if (!before) return null;
    const response = await fetch(`${this.baseUrl}/api/generate`, {
      method: "POST", headers: this.headers(),
      body: JSON.stringify({ model, prompt: "", stream: false, keep_alive: 0 }),
      signal: this.requestSignal(signal, 15_000),
    });
    if (!response.ok) throw new Error(await describeHttpError(response));
    await response.json();
    const deadline = Date.now() + 15_000;
    while (await this.getRunningModel(model, signal)) {
      if (Date.now() >= deadline) throw new Error("Ollama did not release the selected runner; it may still be in use.");
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => { clearTimeout(timer); reject(new Error("Runner release cancelled.")); };
        const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, 250);
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    return before;
  }

  async *chat(options: ChatOptions): AsyncIterable<ChatStreamEvent> {
    const details = this.detailsCache.get(options.model);
    const rawOff = options.think === false && details?.thinking.control === "prompt";
    const body: Record<string, unknown> = rawOff ? {
      model: options.model,
      prompt: qwenNonThinkingPrompt(options.messages),
      raw: true,
      stream: true,
    } : {
      model: options.model,
      messages: options.messages,
      stream: true,
      truncate: false,
      shift: false,
    };
    if (rawOff) {
      body.truncate = false;
      body.shift = false;
    }
    if (options.think !== undefined && details?.thinking.control !== "none") body.think = options.think;
    if (options.keepAlive) body.keep_alive = options.keepAlive;
    if (options.options && Object.keys(options.options).length > 0) body.options = options.options;

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${rawOff ? "/api/generate" : "/api/chat"}`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: this.requestSignal(options.signal, options.timeoutMs ?? this.config.timeoutMs),
      });
    } catch (error) {
      throw this.describe(error, options.timeoutMs ?? this.config.timeoutMs);
    }

    if (!response.ok) throw new Error(await describeHttpError(response));
    if (!response.body) throw new Error("Ollama returned an empty response body.");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let usage: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let stopReason: string | undefined;

    const handleLine = (line: string): ChatStreamEvent[] => {
      const parsed = parseChunk(line);
      if (parsed.error) throw new Error(`Ollama: ${parsed.error}`);
      const events: ChatStreamEvent[] = [];
      if (parsed.thinking) events.push({ type: "reasoning", text: parsed.thinking });
      if (parsed.content) events.push({ type: "text", text: parsed.content });
      if (parsed.done) {
        usage = parsed.usage ?? usage;
        stopReason = parsed.stopReason;
      }
      return events;
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) for (const event of handleLine(line)) yield event;
          newline = buffer.indexOf("\n");
        }
      }
      const tail = buffer.trim();
      if (tail) for (const event of handleLine(tail)) yield event;
      yield { type: "done", usage, stopReason };
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw this.describe(error, options.timeoutMs ?? this.config.timeoutMs);
    } finally {
      try {
        await reader.cancel();
      } catch {
        // The connection may already be closed.
      }
      reader.releaseLock();
    }
  }
}
