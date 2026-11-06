import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import type { Config } from "./config/config.js";
import { LlamaInstaller, type LlamaInstallDependencies } from "./llama-install.js";
import { readHardwareMemory, runtimeWait, type HardwareMemoryStatus, type ParallelStatus } from "./runtime.js";
import type { LoadModelOptions, RunningModelInfo } from "./provider/types.js";
import { GgufCatalog } from "./provider/gguf.js";
import type { LocalRuntime } from "./runtime.js";
import { captureProcess, localRuntimeUrl } from "./runtime-process.js";

export interface LlamaRuntimeDependencies {
  fetch?: typeof fetch;
  installer?: Pick<LlamaInstaller, "ensure" | "locate">;
  install?: LlamaInstallDependencies;
  spawnServer?: (executable: string, args: string[], env: NodeJS.ProcessEnv) => ChildProcess;
  memoryStatus?: () => Promise<HardwareMemoryStatus | null>;
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  checkPort?: () => Promise<void>;
  capture?: typeof captureProcess;
  notice?: (text: string) => void;
}

async function checkPort(baseUrl: string): Promise<void> {
  const url = new URL(baseUrl);
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", () => reject(new Error(`The llama.cpp port ${url.port || "80"} is occupied. TinyCode will not stop another process; set llama.baseUrl to a free loopback port.`)));
    probe.listen(Number(url.port || "80"), url.hostname.replace(/^\[|\]$/g, ""), () => probe.close(() => resolve()));
  });
}

/** A single explicitly owned llama-server. No broad kills or reconfiguration of external servers. */
export class LlamaRuntime implements LocalRuntime {
  readonly installer: Pick<LlamaInstaller, "ensure" | "locate">;
  readonly catalog: GgufCatalog;
  private child: ChildProcess | null = null;
  private running: RunningModelInfo | null = null;
  private apiKey: string | null = null;
  private alias = "";
  private loading: { key: string; task: Promise<RunningModelInfo> } | null = null;
  private logs = "";
  private readonly buffers = new Map<string, number>();
  private readonly helpCache = new Map<string, string>();

  constructor(readonly config: Config["llama"], cwd: string, private readonly dependencies: LlamaRuntimeDependencies = {}) {
    this.installer = dependencies.installer ?? new LlamaInstaller(config, { ...dependencies.install, notice: dependencies.notice });
    this.catalog = new GgufCatalog(config, cwd);
  }
  get apiModel(): string { return this.alias; }
  get owned(): boolean { return this.child !== null && this.child.exitCode === null && this.child.signalCode === null; }
  get baseUrl(): string { return this.config.baseUrl.replace(/\/+$/, ""); }

  headers(): Record<string, string> {
    return { "content-type": "application/json", ...this.config.headers, ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) };
  }

  async request(endpoint: string, body?: Record<string, unknown>, signal?: AbortSignal, timeoutMs = this.config.timeoutMs): Promise<Response> {
    const timeout = AbortSignal.timeout(Math.max(1_000, timeoutMs));
    const response = await (this.dependencies.fetch ?? fetch)(`${this.baseUrl}${endpoint}`, {
      method: body ? "POST" : "GET", headers: this.headers(), ...(body ? { body: JSON.stringify(body) } : {}),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) {
      let message = "";
      try { const raw = await response.json() as { error?: string | { message?: string } }; message = typeof raw.error === "string" ? raw.error : raw.error?.message ?? ""; } catch { /* Status remains useful. */ }
      throw new Error(`llama.cpp request failed (HTTP ${response.status})${message ? `: ${message.slice(0, 600)}` : ""}`);
    }
    return response;
  }

  async props(signal?: AbortSignal): Promise<Record<string, unknown>> {
    return await (await this.request("/props", undefined, signal, 10_000)).json() as Record<string, unknown>;
  }

  async available(): Promise<boolean> {
    try {
      const response = await this.request("/health", undefined, undefined, 1_500);
      return (await response.json() as { status?: string }).status === "ok";
    } catch { return false; }
  }

  /** Detect/install the executable, but never allocate weights on the welcome screen. */
  async ensureStarted(signal?: AbortSignal): Promise<boolean> {
    if (await this.available()) return false;
    if (!localRuntimeUrl(this.baseUrl)) throw new Error("Remote llama.cpp is unavailable. Its owner must start it; TinyCode never installs or starts engines remotely.");
    await this.installer.ensure(signal);
    return false;
  }

  async getRunningModel(model: string, signal?: AbortSignal): Promise<RunningModelInfo | null> {
    if (!(await this.available())) {
      // A slow health response is not proof that the owned allocation disappeared.
      if (!this.owned) this.running = null;
      return null;
    }
    const props = await this.props(signal);
    const list = await (await this.request("/v1/models", undefined, signal, 10_000)).json() as { data?: Array<{ id: string; owned_by?: string; meta?: { size?: number; n_ctx_train?: number } }> };
    const serverModel = list.data?.[0];
    if (!serverModel || (serverModel.owned_by && !/llama/i.test(serverModel.owned_by))) throw new Error("Configured server is not a verified llama.cpp model API.");
    const file = typeof props.model_path === "string" ? props.model_path : "";
    const wanted = await this.catalog.resolve(model).catch(() => "");
    const normalize = (value: string): string => process.platform === "win32" ? value.replace(/\\/g, "/").toLowerCase() : value;
    const matches = this.owned ? this.running?.id === model && serverModel.id === this.alias
      : serverModel.id === model || Boolean(file && wanted && normalize(file) === normalize(wanted));
    if (!matches) return null;
    const settings = props.default_generation_settings as { n_ctx?: number } | undefined;
    const tokens = settings?.n_ctx;
    if (!Number.isInteger(tokens) || Number(tokens) < 256) throw new Error("llama.cpp did not report a valid per-slot n_ctx in /props.");
    this.alias = serverModel.id;
    if (this.owned && this.running) { this.running.contextLength = tokens!; return this.running; }
    return { id: model, sizeBytes: serverModel.meta?.size ?? 0, sizeVramBytes: 0, contextLength: tokens!, memoryKnown: false };
  }

  async loadModel(options: LoadModelOptions): Promise<RunningModelInfo> {
    if (!Number.isInteger(options.numCtx) || options.numCtx < 256) throw new Error("A finite explicit llama.cpp context size is required.");
    options.signal?.throwIfAborted();
    const key = `${options.model}:${options.numCtx}`;
    if (this.loading) {
      if (this.loading.key !== key) throw new Error("Another llama.cpp model/context is loading.");
      return this.loading.task;
    }
    const task = this.load(options);
    this.loading = { key, task };
    try { return await task; } finally { this.loading = null; }
  }

  private async load(options: LoadModelOptions): Promise<RunningModelInfo> {
    const existing = await this.getRunningModel(options.model, options.signal);
    if (existing?.contextLength === options.numCtx) return existing;
    if (await this.available() && !this.owned) throw new Error("An external llama-server is already running on the configured port with a different model/context. TinyCode will not stop it. Use its exact context or a separate local port.");
    const [file, details] = await Promise.all([this.catalog.resolve(options.model), this.catalog.getDetails(options.model)]);
    if (options.numCtx > (details.contextLength ?? 1_048_576)) throw new Error(`GGUF context limit is ${details.contextLength} tokens.`);
    if (this.child) {
      const before = await this.memoryStatus();
      const released = this.running?.sizeVramBytes ?? 0;
      await this.stopChild();
      await this.waitForMemoryRelease(before, released, options.signal);
    }
    if (!localRuntimeUrl(this.baseUrl)) throw new Error("A remote llama.cpp model must be loaded by its owner.");
    const executable = await this.installer.ensure(options.signal);
    let help = this.helpCache.get(executable);
    if (help === undefined) {
      help = await (this.dependencies.capture ?? captureProcess)(executable, ["--help"], options.signal);
      this.helpCache.set(executable, help);
    }
    const gpuHelp = /--(?:n-)?gpu-layers\b([\s\S]*?)(?=\r?\n\s*-[a-zA-Z]|$)/.exec(help)?.[1] ?? "";
    const gpuLayers = this.config.backend === "cpu" ? 0 : this.config.gpuLayers;
    if (gpuLayers === "auto" && !/\bauto\b/.test(gpuHelp)) {
      throw new Error("Installed llama-server does not support automatic GPU offload. Update llama.cpp or set llama.gpuLayers to an explicit layer count; no model was loaded.");
    }
    await (this.dependencies.checkPort ?? (() => checkPort(this.baseUrl)))();
    options.signal?.throwIfAborted();
    const url = new URL(this.baseUrl);
    this.alias = `tinycode-${createHash("sha256").update(file).digest("hex").slice(0, 16)}`;
    const args = [
      "--model", file, "--alias", this.alias, "--host", url.hostname.replace(/^\[|\]$/g, ""), "--port", url.port || "80",
      "--ctx-size", String(options.numCtx * this.config.parallel), "--parallel", String(this.config.parallel),
      "--batch-size", String(this.config.batchSize), "--ubatch-size", String(this.config.microBatchSize),
      "--gpu-layers", String(gpuLayers), "--flash-attn", this.config.flashAttention,
      "--load-mode", this.config.loadMode, "--fit", "on", "--fit-target", String(this.config.fitTargetMiB),
      "--cache-type-k", this.config.cacheTypeK, "--cache-type-v", this.config.cacheTypeV,
      "--jinja", "--reasoning-format", "deepseek", "--no-context-shift", "--offline", "--no-warmup",
      ...(help.includes("--no-webui") ? ["--no-webui"] : []), ...(help.includes("--no-agent") ? ["--no-agent"] : []),
      ...(this.config.cpuMoe ? ["--cpu-moe"] : []), ...(this.config.kvOffload ? [] : ["--no-kv-offload"]),
      ...(this.config.threads > 0 ? ["--threads", String(this.config.threads)] : []),
    ];
    this.apiKey = randomBytes(24).toString("hex");
    // Inherited llama settings must not secretly enable model downloads, server tools or tunnels.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("LLAMA_ARG_") && key !== "LLAMA_API_KEY"));
    env.LLAMA_API_KEY = this.apiKey;
    this.logs = ""; this.buffers.clear();
    let failure: Error | null = null, lineBuffer = "";
    const child = this.dependencies.spawnServer ? this.dependencies.spawnServer(executable, args, env) : spawn(executable, args, {
      windowsHide: true, detached: false, shell: false, stdio: ["ignore", "pipe", "pipe"], env,
    });
    this.child = child;
    const log = (chunk: string | Buffer): void => {
      const text = chunk.toString(); this.logs = (this.logs + text).slice(-16_000);
      lineBuffer += text;
      let newline = lineBuffer.indexOf("\n");
      while (newline !== -1) {
        const line = lineBuffer.slice(0, newline);
        lineBuffer = lineBuffer.slice(newline + 1);
        const allocation = /(?:^|\s)([A-Za-z0-9_]+)\s+(model |KV )?buffer size\s*=\s*([\d.]+)\s*MiB/i.exec(line);
        if (allocation) this.buffers.set(`${allocation[1]}:${allocation[2] ?? "model "}`, Number(allocation[3]) * 1024 ** 2);
        newline = lineBuffer.indexOf("\n");
      }
      if (lineBuffer.length > 16_000) lineBuffer = lineBuffer.slice(-16_000);
    };
    child.stdout?.on("data", log); child.stderr?.on("data", log);
    child.once("error", (error) => { failure = error; });
    this.running = { id: options.model, sizeBytes: details.sizeBytes ?? 0, sizeVramBytes: 0, contextLength: options.numCtx, memoryKnown: false };
    try {
      const deadline = Date.now() + this.config.startupTimeoutMs;
      while (!(await this.available())) {
        options.signal?.throwIfAborted();
        if (failure || child.exitCode !== null || child.signalCode !== null) throw new Error(`llama-server startup failed: ${failure ? (failure as Error).message : this.logs.slice(-1800) || `exit ${child.exitCode}`}`);
        if (Date.now() >= deadline) throw new Error(`llama-server did not load within ${this.config.startupTimeoutMs / 1000}s. ${this.logs.slice(-600)}`);
        await (this.dependencies.wait ?? runtimeWait)(250, options.signal);
      }
      const total = [...this.buffers.values()].reduce((sum, value) => sum + value, 0);
      const vram = [...this.buffers].filter(([key]) => /^(CUDA\d|Vulkan\d|Metal|ROCm\d)/i.test(key)).reduce((sum, [, value]) => sum + value, 0);
      this.running.sizeBytes = Math.max(details.sizeBytes ?? 0, total);
      this.running.sizeVramBytes = vram;
      this.running.memoryKnown = total > 0;
      const verified = await this.getRunningModel(options.model, options.signal);
      if (!verified || verified.contextLength !== options.numCtx) throw new Error(`llama.cpp loaded ${verified?.contextLength ?? "unknown"} tokens per slot instead of ${options.numCtx}. No generation was sent.`);
      return verified;
    } catch (error) { await this.stopChild(); throw error; }
  }

  async unloadModel(model: string, signal?: AbortSignal): Promise<RunningModelInfo | null> {
    signal?.throwIfAborted();
    const previous = await this.getRunningModel(model, signal);
    if (!this.child) {
      if (previous) throw new Error("TinyCode does not own this llama-server. External processes are not stopped or unloaded.");
      return null;
    }
    await this.stopChild();
    return previous;
  }

  private async stopChild(): Promise<void> {
    const child = this.child;
    if (!child) return;
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const cleanup = (): void => { clearTimeout(force); clearTimeout(timeout); child.removeListener("exit", finish); };
        const finish = (): void => { if (settled) return; settled = true; cleanup(); resolve(); };
        const force = setTimeout(() => { child.kill("SIGKILL"); }, 5_000);
        const timeout = setTimeout(() => { if (settled) return; settled = true; cleanup(); reject(new Error("Owned llama-server did not stop; no new allocation was started.")); }, 10_000);
        child.once("exit", finish);
        const sent = child.kill("SIGTERM"); // Exact child only; llama-server does not spawn model runners.
        if (!sent || child.exitCode !== null || child.signalCode !== null) finish();
      });
    }
    this.child = null; this.running = null; this.apiKey = null; this.alias = "";
  }

  async memoryStatus(): Promise<HardwareMemoryStatus | null> {
    if (!localRuntimeUrl(this.baseUrl)) return null;
    return this.dependencies.memoryStatus ? this.dependencies.memoryStatus() : readHardwareMemory();
  }
  async waitForMemoryRelease(before: HardwareMemoryStatus | null, releasedVram: number, signal?: AbortSignal, minimumFree?: number): Promise<void> {
    const wait = this.dependencies.wait ?? runtimeWait;
    if (!before?.gpus.length || releasedVram < 32 * 1024 ** 2 && minimumFree === undefined) { await wait(750, signal); return; }
    const total = before.gpus.reduce((sum, gpu) => sum + gpu.totalBytes, 0);
    const free = before.gpus.reduce((sum, gpu) => sum + gpu.freeBytes, 0);
    const target = Math.min(total - 256 * 1024 ** 2, minimumFree ?? free + releasedVram * .75);
    const deadline = Date.now() + 30_000;
    while (true) {
      signal?.throwIfAborted();
      const memory = await this.memoryStatus();
      if (!memory?.gpus.length || memory.gpus.reduce((sum, gpu) => sum + gpu.freeBytes, 0) >= target) return;
      if (Date.now() >= deadline) throw new Error("VRAM was not released after stopping llama-server. No replacement was loaded.");
      await wait(250, signal);
    }
  }
  async restartServer(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (!localRuntimeUrl(this.baseUrl) || !this.child && await this.available()) throw new Error("Only a TinyCode-owned local llama-server can be restarted.");
    await this.stopChild(); // Replacement is loaded explicitly, once, by the caller.
  }
  async parallelStatus(): Promise<ParallelStatus> {
    if (await this.available()) {
      const props = await this.props();
      return { value: typeof props.total_slots === "number" ? props.total_slots : null, source: this.owned ? "TinyCode-managed llama-server" : "external llama-server /props", local: localRuntimeUrl(this.baseUrl), canSet: this.owned };
    }
    return { value: this.config.parallel, source: "llama.cpp startup setting", local: localRuntimeUrl(this.baseUrl), canSet: localRuntimeUrl(this.baseUrl) };
  }
  async setParallelOne(): Promise<ParallelStatus> {
    const status = await this.parallelStatus();
    if (!status.canSet) throw new Error("External llama.cpp parallel settings must be changed by its owner.");
    this.config.parallel = 1;
    await this.stopChild();
    return { value: 1, source: "saved for next llama.cpp load", local: true, canSet: true, restartRequired: false };
  }
  async dispose(waitForMemory = false): Promise<void> {
    if (!this.child) return;
    const before = waitForMemory ? await this.memoryStatus().catch(() => null) : null;
    const released = waitForMemory ? this.running?.sizeVramBytes ?? 0 : 0;
    await this.stopChild();
    if (waitForMemory) await this.waitForMemoryRelease(before, released);
  }
}
