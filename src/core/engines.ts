import type { Config, ProviderId } from "./config/config.js";
import { OllamaRuntime } from "./ollama-runtime.js";
import { LlamaRuntime } from "./llama-runtime.js";
import { LlamaProvider } from "./provider/llama.js";
import { OllamaProvider } from "./provider/ollama.js";
import { OpenAICompatibleProvider } from "./provider/openai-compatible.js";
import { ProviderRegistry } from "./provider/registry.js";
import { PassiveRuntime } from "./passive-runtime.js";
import type { ChatOptions, ChatStreamEvent, LoadModelOptions, Provider } from "./provider/types.js";
import type { LocalRuntime } from "./runtime.js";
import { errorMessage } from "../util/errors.js";

/** Provider and runtime switch as a pair. Chat/TUI never keep a stale engine instance. */
export class LocalEngines implements Provider, LocalRuntime {
  private active: string;
  private releasingOllama: Promise<void> | null = null;
  constructor(private readonly config: Config, private readonly providers: ProviderRegistry, private readonly runtimes: Map<string, LocalRuntime>) {
    this.active = config.provider;
    providers.get(this.active);
  }
  get id(): string { return this.active; }
  get name(): string { return this.provider.name; }
  private get provider(): Provider { return this.providers.get(this.active); }
  private get runtime(): LocalRuntime {
    const runtime = this.runtimes.get(this.active);
    if (!runtime) throw new Error(`No runtime registered for ${this.active}.`);
    return runtime;
  }
  private async releaseSelectedOllamaRunner(): Promise<void> {
    if (this.releasingOllama) return this.releasingOllama;
    const operation = (async () => {
      const provider = this.providers.get("ollama");
      const runtime = this.runtimes.get("ollama");
      const model = this.config.providerModels.ollama;
      if (!runtime || !model || !provider.getRunningModel || !provider.unloadModel) return;
      const running = await provider.getRunningModel(model).catch(() => null);
      if (!running) return;
      const before = await runtime.memoryStatus().catch(() => null);
      const released = await provider.unloadModel(model);
      if (released) await runtime.waitForMemoryRelease(before, released.sizeVramBytes);
    })();
    this.releasingOllama = operation;
    try { await operation; } finally { this.releasingOllama = null; }
  }
  listProviders(): Array<{ id: string; name: string }> { return this.providers.list().map(({ id, name }) => ({ id, name })); }
  async listProviderModels(signal?: AbortSignal) {
    const order = new Map([["ollama", 0], ["llama.cpp", 1]]);
    const providers = this.providers.list().sort((a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99));
    return Promise.all(providers.map(async (provider) => {
      try {
        if (provider.id === "ollama") await this.runtimes.get(provider.id)?.ensureStarted(signal);
        return { provider: { id: provider.id, name: provider.name }, models: await provider.listModels(signal) };
      } catch (error) {
        return { provider: { id: provider.id, name: provider.name }, models: [], error: errorMessage(error) };
      }
    }));
  }
  async getProviderModelDetails(provider: string, model: string) {
    const selected = this.providers.get(provider);
    return selected.getModelDetails ? selected.getModelDetails(model)
      : { id: model, name: model, thinking: { modes: ["off"], defaultMode: "off", control: "none" as const } };
  }
  async prepareProviderModel(provider: string, options: LoadModelOptions): Promise<void> {
    const selected = this.providers.get(provider);
    const runtime = this.runtimes.get(provider);
    if (!runtime) throw new Error(`No runtime registered for ${provider}.`);
    if (provider === "llama.cpp") await this.releaseSelectedOllamaRunner();
    await runtime.ensureStarted(options.signal);
    if (selected.loadModel) await selected.loadModel(options);
  }
  chatWithProvider(provider: string, options: ChatOptions): AsyncIterable<ChatStreamEvent> {
    return this.providers.get(provider).chat(options);
  }
  async selectProvider(id: string): Promise<void> {
    this.providers.get(id);
    if (id === this.active) return;
    if (this.active === "ollama") {
      await this.releaseSelectedOllamaRunner();
      // Release only the selected runner. The Ollama daemon and unrelated models stay alive.
    }
    await this.runtime.dispose?.(true); // Only a TinyCode-owned llama-server can be stopped.
    this.active = id;
    this.config.provider = id as ProviderId;
  }
  listModels(signal?: AbortSignal) { return this.provider.listModels(signal); }
  listDraftModels(signal?: AbortSignal) { return this.provider.listDraftModels?.(signal) ?? Promise.resolve([]); }
  async getModelDetails(model: string) {
    return this.provider.getModelDetails ? this.provider.getModelDetails(model) : { id: model, name: model, thinking: { modes: ["off"], defaultMode: "off", control: "none" as const } };
  }
  async getRunningModel(model: string, signal?: AbortSignal) { return this.provider.getRunningModel?.(model, signal) ?? null; }
  async loadModel(options: LoadModelOptions) {
    if (this.active === "llama.cpp") await this.releaseSelectedOllamaRunner();
    return this.provider.loadModel?.(options) ?? null;
  }
  async unloadModel(model: string, signal?: AbortSignal) { return this.provider.unloadModel?.(model, signal) ?? null; }
  chat(options: ChatOptions): AsyncIterable<ChatStreamEvent> { return this.provider.chat(options); }
  health() { return this.provider.health(); }
  available() { return this.runtime.available(); }
  ensureStarted(signal?: AbortSignal) { return this.runtime.ensureStarted(signal); }
  parallelStatus() { return this.runtime.parallelStatus(); }
  memoryStatus() { return this.runtime.memoryStatus(); }
  waitForMemoryRelease(...args: Parameters<LocalRuntime["waitForMemoryRelease"]>) { return this.runtime.waitForMemoryRelease(...args); }
  restartServer(signal?: AbortSignal) { return this.runtime.restartServer(signal); }
  setParallelOne() { return this.runtime.setParallelOne(); }
  async dispose(): Promise<void> { for (const runtime of this.runtimes.values()) await runtime.dispose?.(); }
}

export function createLocalEngines(config: Config, cwd: string, notice?: (text: string) => void): LocalEngines {
  const llama = new LlamaRuntime(config.llama, cwd, { notice });
  const ollama = new OllamaRuntime(config.ollama);
  const registry = new ProviderRegistry().register(new LlamaProvider(llama)).register(new OllamaProvider(config.ollama));
  const runtimes = new Map<string, LocalRuntime>([["llama.cpp", llama], ["ollama", ollama]]);
  for (const [id, externalConfig] of Object.entries(config.providers)) {
    const provider = new OpenAICompatibleProvider(id, externalConfig);
    registry.register(provider);
    runtimes.set(id, new PassiveRuntime(provider));
  }
  return new LocalEngines(config, registry, runtimes);
}
