import { configFile } from "../../util/paths.js";
import { pathExists, readJson, writeJsonAtomic } from "../../util/fs.js";

export type ThemeName = "dark" | "light";
export type ProviderId = string;

export interface OpenAICompatibleModelConfig {
  name: string;
  contextLength: number;
  parameterSize?: string;
  quantization?: string;
  family?: string;
  thinking: false | {
    modes: string[];
    defaultMode: string;
    field: "reasoning_effort" | "think" | "none";
    values: Record<string, boolean | string>;
  };
}

export interface OpenAICompatibleProviderConfig {
  type: "openai-compatible";
  name: string;
  baseUrl: string;
  apiKeyEnv: string | null;
  headers: Record<string, string>;
  timeoutMs: number;
  extraBody: Record<string, unknown>;
  models: Record<string, OpenAICompatibleModelConfig>;
}

export interface Config {
  provider: ProviderId;
  /** Model id/path for the selected engine. Empty until a local GGUF is chosen. */
  model: string;
  providerModels: Record<string, string>;
  /** User-declared external APIs; model limits/capabilities are never guessed. */
  providers: Record<string, OpenAICompatibleProviderConfig>;
  models: Record<string, { thinking: string; numCtx: number; sampling?: SamplingConfig }>;
  llama: {
    executable: string | null;
    autoInstall: boolean;
    /** Official release tag, or latest (stable release's matching binary build). */
    release: string;
    backend: "auto" | "cuda" | "vulkan" | "cpu" | "metal";
    baseUrl: string;
    timeoutMs: number;
    startupTimeoutMs: number;
    modelDirs: string[];
    /** Aliases mapped to existing local GGUF files. */
    models: Record<string, string>;
    headers: Record<string, string>;
    extraOptions: Record<string, unknown>;
    gpuLayers: number | "auto";
    cpuMoe: boolean;
    kvOffload: boolean;
    loadMode: "auto" | "none" | "mmap" | "mlock" | "mmap+mlock" | "dio";
    fitTargetMiB: number;
    flashAttention: "auto" | "on" | "off";
    cacheTypeK: string;
    cacheTypeV: string;
    batchSize: number;
    microBatchSize: number;
    threads: number;
    parallel: number;
  };
  ollama: {
    /** Overall request timeout. Loading a model can take a while on first use. */
    baseUrl: string;
    timeoutMs: number;
    keepAlive: string;
    headers: Record<string, string>;
    /** Extra Ollama options merged into every request. */
    extraOptions: Record<string, unknown>;
    autoStart: boolean;
    startupTimeoutMs: number;
    /** Override only when TinyCode starts its own local Ollama server. */
    parallel: number | null;
  };
  generation: {
    temperature: number;
    topP: number;
    numCtx: number;
    numPredict: number;
    repeatPenalty: number;
    seed: number | null;
    stop: string[];
    thinking: string;
    samplingProfile: "auto" | "model" | "qwen3-thinking" | "qwen3-fast" | "custom";
  };
  context: {
    /** Legacy field retained for config compatibility; ignored by the agent. */
    maxMessages: number;
    /** Legacy field retained for config compatibility; ignored by the agent. */
    maxChars: number;
  };
  tools: {
    /** Enable the agent loop, system prompt and tool calls. */
    enabled: boolean;
    /** Skip command approval and explicit MCP server approval restrictions. */
    autoApprove: boolean;
    /** Maximum model turns in one user request. */
    maxIterations: number;
    commandTimeoutMs: number;
    maxOutputChars: number;
    /** Optional path to a custom system prompt file. */
    promptFile: string | null;
    maxStalledSteps: number;
    profile: "auto" | "plan" | "edit" | "full";
    /** Resolve the default auto/full profile from model size unless manually pinned. */
    profileByModel: boolean;
    stopAfterToolCall: boolean;
  };
  compaction: {
    /** Enable manual and automatic session compaction. */
    enabled: boolean;
    auto: boolean;
    /** Compact when estimated context usage reaches this ratio. */
    threshold: number;
    /** Never compact this many newest messages. */
    keepRecentMessages: number;
    /** Auto-compaction starts only after this many active messages. */
    minMessages: number;
    maxSummaryChars: number;
    numPredict: number;
    /** Optional custom compaction system prompt. */
    promptFile: string | null;
  };
  goal: {
    enabled: boolean;
    /** Optional evaluator overrides are activated when provider routing supports them. */
    provider: string | null;
    model: string | null;
    numPredict: number;
    maxContinuations: number;
  };
  ui: {
    theme: ThemeName;
    showReasoning: boolean;
    showToolOutput: boolean;
    mouse: boolean;
  };
  session: {
    /** Derive a session title from the first user message. */
    autoTitle: boolean;
  };
  mcp: {
    enabled: boolean;
    servers: Record<string, {
      enabled: boolean;
      command: string;
      args: string[];
      env: Record<string, string>;
      cwd?: string;
      /** Auto-approve calls by default; false explicitly requires approval. */
      safe: boolean;
    }>;
  };
}

export interface SamplingConfig {
  profile: "auto" | "model" | "qwen3-thinking" | "qwen3-fast" | "custom";
  temperature?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  repeatPenalty?: number;
  presencePenalty?: number;
}

export function defaultConfig(): Config {
  return {
    provider: "llama.cpp",
    model: "",
    providerModels: { "llama.cpp": "", ollama: "qwen2.5-coder:7b" },
    providers: {},
    models: {},
    llama: {
      executable: null, autoInstall: true, release: "latest", backend: "auto",
      baseUrl: "http://127.0.0.1:8081", timeoutMs: 600_000, startupTimeoutMs: 120_000,
      modelDirs: [], models: {}, headers: {}, extraOptions: {},
      gpuLayers: "auto", cpuMoe: false, kvOffload: true,
      loadMode: process.platform === "win32" ? "none" : "auto", fitTargetMiB: 512,
      flashAttention: "auto", cacheTypeK: "f16", cacheTypeV: "f16",
      batchSize: 256, microBatchSize: 256, threads: 0, parallel: 1,
    },
    ollama: {
      baseUrl: "http://127.0.0.1:11434",
      timeoutMs: 600_000,
      keepAlive: "5m",
      headers: {},
      extraOptions: {},
      autoStart: true,
      startupTimeoutMs: 20_000,
      parallel: null,
    },
    generation: {
      temperature: 0.2,
      topP: 0.9,
      numCtx: 8192,
      numPredict: 2048,
      repeatPenalty: 1.05,
      seed: null,
      stop: [],
      thinking: "off",
      samplingProfile: "auto",
    },
    context: {
      maxMessages: 0,
      maxChars: 0,
    },
    tools: {
      enabled: true,
      autoApprove: false,
      maxIterations: 16,
      commandTimeoutMs: 120_000,
      maxOutputChars: 24_000,
      promptFile: null,
      maxStalledSteps: 3,
      profile: "auto",
      profileByModel: true,
      stopAfterToolCall: false,
    },
    compaction: {
      enabled: true,
      auto: true,
      threshold: 0.72,
      keepRecentMessages: 6,
      minMessages: 10,
      maxSummaryChars: 6_000,
      numPredict: 1_024,
      promptFile: null,
    },
    goal: { enabled: true, provider: null, model: null, numPredict: 512, maxContinuations: 3 },
    ui: {
      theme: "dark",
      showReasoning: true,
      showToolOutput: true,
      mouse: true,
    },
    session: {
      autoTitle: true,
    },
    mcp: { enabled: true, servers: {} },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function readNumber(value: unknown, fallback: number, min?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return min === undefined ? value : Math.max(min, value);
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readStringArray(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : fallback;
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) return "http://127.0.0.1:11434";
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

/** Merge a user config over the defaults. Unknown keys and bad types are ignored. */
export function mergeConfig(raw: unknown): Config {
  const config = defaultConfig();
  if (!isObject(raw)) return config;

  // Existing installations keep their Ollama model ids and sessions intact.
  if (typeof raw.provider === "string" && raw.provider.trim()) config.provider = raw.provider.trim();
  else if (raw.model !== undefined || raw.ollama !== undefined) config.provider = "ollama";
  if (isObject(raw.providerModels)) {
    for (const [id, value] of Object.entries(raw.providerModels)) if (typeof value === "string") config.providerModels[id] = value.trim();
  }
  const explicitModel = typeof raw.model === "string" ? raw.model.trim() : "";
  config.model = explicitModel || config.providerModels[config.provider] || "";
  config.providerModels[config.provider] = config.model;

  if (isObject(raw.providers)) {
    for (const [id, value] of Object.entries(raw.providers)) {
      if (["ollama", "llama.cpp"].includes(id) || !/^[A-Za-z0-9._-]+$/.test(id) || !isObject(value) || value.type !== "openai-compatible") continue;
      const models: OpenAICompatibleProviderConfig["models"] = {};
      if (isObject(value.models)) for (const [modelId, modelValue] of Object.entries(value.models)) {
        if (!modelId.trim() || !isObject(modelValue)) continue;
        const rawThinking = modelValue.thinking;
        let thinking: OpenAICompatibleModelConfig["thinking"] = false;
        if (rawThinking === true) {
          thinking = { modes: ["off", "on"], defaultMode: "off", field: "reasoning_effort", values: { off: "none", on: "medium" } };
        } else if (isObject(rawThinking)) {
          const modes = readStringArray(rawThinking.modes, ["off"]);
          const unique = [...new Set(modes.map((mode) => mode.trim()).filter(Boolean))];
          const field = ["reasoning_effort", "think", "none"].includes(String(rawThinking.field)) ? rawThinking.field as "reasoning_effort" | "think" | "none" : "reasoning_effort";
          const values = isObject(rawThinking.values)
            ? Object.fromEntries(Object.entries(rawThinking.values).filter((entry): entry is [string, boolean | string] => typeof entry[1] === "boolean" || typeof entry[1] === "string")) : {};
          const defaultMode = typeof rawThinking.defaultMode === "string" && unique.includes(rawThinking.defaultMode) ? rawThinking.defaultMode : unique[0] ?? "off";
          thinking = { modes: unique.length ? unique : ["off"], defaultMode, field, values };
        }
        models[modelId] = {
          name: readString(modelValue.name, modelId),
          contextLength: Math.round(readNumber(modelValue.contextLength, config.generation.numCtx, 256)),
          ...(typeof modelValue.parameterSize === "string" ? { parameterSize: modelValue.parameterSize } : {}),
          ...(typeof modelValue.quantization === "string" ? { quantization: modelValue.quantization } : {}),
          ...(typeof modelValue.family === "string" ? { family: modelValue.family } : {}),
          thinking,
        };
      }
      config.providers[id] = {
        type: "openai-compatible",
        name: readString(value.name, id),
        baseUrl: normalizeBaseUrl(readString(value.baseUrl, "http://127.0.0.1:8000/v1")),
        apiKeyEnv: typeof value.apiKeyEnv === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value.apiKeyEnv) ? value.apiKeyEnv : null,
        headers: isObject(value.headers) ? Object.fromEntries(Object.entries(value.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {},
        timeoutMs: readNumber(value.timeoutMs, 600_000, 1_000),
        extraBody: isObject(value.extraBody) ? { ...value.extraBody } : {},
        models,
      };
      if (!config.providerModels[id]) config.providerModels[id] = Object.keys(models)[0] ?? "";
    }
  }

  if (!["ollama", "llama.cpp"].includes(config.provider) && !config.providers[config.provider]) config.provider = "llama.cpp";
  if (!config.providerModels[config.provider]) config.providerModels[config.provider] = Object.keys(config.providers[config.provider]?.models ?? {})[0] ?? "";
  config.model = explicitModel || config.providerModels[config.provider] || "";
  config.providerModels[config.provider] = config.model;

  if (isObject(raw.llama)) {
    const llama = raw.llama;
    const legacyBatchDefaults = llama.microBatchSize === 128 && llama.loadMode === undefined && llama.fitTargetMiB === undefined;
    config.llama.executable = typeof llama.executable === "string" && llama.executable.trim() ? llama.executable.trim() : null;
    config.llama.autoInstall = readBoolean(llama.autoInstall, config.llama.autoInstall);
    config.llama.release = readString(llama.release, config.llama.release);
    if (["auto", "cuda", "vulkan", "cpu", "metal"].includes(String(llama.backend))) config.llama.backend = llama.backend as Config["llama"]["backend"];
    config.llama.baseUrl = normalizeBaseUrl(readString(llama.baseUrl, config.llama.baseUrl));
    config.llama.timeoutMs = readNumber(llama.timeoutMs, config.llama.timeoutMs, 1_000);
    config.llama.startupTimeoutMs = readNumber(llama.startupTimeoutMs, config.llama.startupTimeoutMs, 1_000);
    config.llama.modelDirs = readStringArray(llama.modelDirs, []);
    for (const key of ["models", "headers"] as const) {
      if (isObject(llama[key])) for (const [name, value] of Object.entries(llama[key])) if (typeof value === "string") config.llama[key][name] = value;
    }
    if (isObject(llama.extraOptions)) config.llama.extraOptions = { ...llama.extraOptions };
    if (typeof llama.gpuLayers === "number" && Number.isFinite(llama.gpuLayers)) config.llama.gpuLayers = Math.max(0, Math.floor(llama.gpuLayers));
    config.llama.cpuMoe = readBoolean(llama.cpuMoe, config.llama.cpuMoe);
    config.llama.kvOffload = readBoolean(llama.kvOffload, config.llama.kvOffload);
    if (["auto", "none", "mmap", "mlock", "mmap+mlock", "dio"].includes(String(llama.loadMode))) config.llama.loadMode = llama.loadMode as Config["llama"]["loadMode"];
    config.llama.fitTargetMiB = Math.min(16_384, Math.round(readNumber(llama.fitTargetMiB, config.llama.fitTargetMiB, 128)));
    if (["auto", "on", "off"].includes(String(llama.flashAttention))) config.llama.flashAttention = llama.flashAttention as Config["llama"]["flashAttention"];
    const cacheTypes = ["f32", "f16", "bf16", "q8_0", "q4_0", "q4_1", "iq4_nl", "q5_0", "q5_1"];
    for (const key of ["cacheTypeK", "cacheTypeV"] as const) if (cacheTypes.includes(String(llama[key]))) config.llama[key] = String(llama[key]);
    for (const key of ["batchSize", "microBatchSize"] as const) config.llama[key] = Math.min(8192, Math.round(readNumber(llama[key], config.llama[key], 1)));
    if (legacyBatchDefaults) config.llama.microBatchSize = 256;
    config.llama.microBatchSize = Math.min(config.llama.batchSize, config.llama.microBatchSize);
    config.llama.threads = Math.round(readNumber(llama.threads, config.llama.threads, 0));
    config.llama.parallel = Math.min(16, Math.round(readNumber(llama.parallel, config.llama.parallel, 1)));
  }

  if (isObject(raw.ollama)) {
    const ollama = raw.ollama;
    config.ollama.baseUrl = normalizeBaseUrl(readString(ollama.baseUrl, config.ollama.baseUrl));
    config.ollama.timeoutMs = readNumber(ollama.timeoutMs, config.ollama.timeoutMs, 1_000);
    config.ollama.keepAlive = readString(ollama.keepAlive, config.ollama.keepAlive);
    if (isObject(ollama.headers)) {
      for (const [key, value] of Object.entries(ollama.headers)) {
        if (typeof value === "string") config.ollama.headers[key] = value;
      }
    }
    if (isObject(ollama.extraOptions)) config.ollama.extraOptions = { ...ollama.extraOptions };
    config.ollama.autoStart = readBoolean(ollama.autoStart, config.ollama.autoStart);
    config.ollama.startupTimeoutMs = readNumber(ollama.startupTimeoutMs, config.ollama.startupTimeoutMs, 1_000);
    if (typeof ollama.parallel === "number" && Number.isFinite(ollama.parallel)) {
      config.ollama.parallel = Math.max(1, Math.min(16, Math.round(ollama.parallel)));
    }
  }

  if (isObject(raw.generation)) {
    const generation = raw.generation;
    config.generation.temperature = readNumber(generation.temperature, config.generation.temperature, 0);
    config.generation.topP = readNumber(generation.topP, config.generation.topP, 0);
    config.generation.numCtx = readNumber(generation.numCtx, config.generation.numCtx, 256);
    config.generation.numPredict = readNumber(generation.numPredict, config.generation.numPredict, 1);
    config.generation.repeatPenalty = readNumber(generation.repeatPenalty, config.generation.repeatPenalty, 0);
    config.generation.seed =
      typeof generation.seed === "number" && Number.isFinite(generation.seed) ? generation.seed : config.generation.seed;
    config.generation.stop = readStringArray(generation.stop, config.generation.stop);
    config.generation.thinking = readString(generation.thinking, config.generation.thinking);
    if (["auto", "model", "qwen3-thinking", "qwen3-fast", "custom"].includes(String(generation.samplingProfile))) {
      config.generation.samplingProfile = generation.samplingProfile as Config["generation"]["samplingProfile"];
    }
  }

  if (isObject(raw.models)) {
    for (const [id, preference] of Object.entries(raw.models)) {
      if (!isObject(preference)) continue;
      config.models[id] = {
        thinking: readString(preference.thinking, config.generation.thinking),
        numCtx: Math.round(readNumber(preference.numCtx, config.generation.numCtx, 256)),
        sampling: parseSampling(preference.sampling, config.generation.samplingProfile),
      };
    }
  }

  if (isObject(raw.context)) {
    config.context.maxMessages = readNumber(raw.context.maxMessages, config.context.maxMessages, 0);
    config.context.maxChars = readNumber(raw.context.maxChars, config.context.maxChars, 0);
  }

  if (isObject(raw.tools)) {
    const tools = raw.tools;
    config.tools.enabled = readBoolean(tools.enabled, config.tools.enabled);
    config.tools.autoApprove = readBoolean(tools.autoApprove, config.tools.autoApprove);
    config.tools.maxIterations = readNumber(tools.maxIterations, config.tools.maxIterations, 1);
    config.tools.commandTimeoutMs = readNumber(tools.commandTimeoutMs, config.tools.commandTimeoutMs, 1_000);
    config.tools.maxOutputChars = readNumber(tools.maxOutputChars, config.tools.maxOutputChars, 1_000);
    config.tools.maxStalledSteps = Math.round(readNumber(tools.maxStalledSteps, config.tools.maxStalledSteps, 1));
    if (["auto", "plan", "edit", "full"].includes(String(tools.profile))) config.tools.profile = tools.profile as Config["tools"]["profile"];
    config.tools.profileByModel = readBoolean(tools.profileByModel, config.tools.profileByModel);
    config.tools.stopAfterToolCall = readBoolean(tools.stopAfterToolCall, config.tools.stopAfterToolCall);
    config.tools.promptFile =
      typeof tools.promptFile === "string" && tools.promptFile.trim()
        ? tools.promptFile.trim()
        : config.tools.promptFile;
  }

  if (isObject(raw.compaction)) {
    const compaction = raw.compaction;
    config.compaction.enabled = readBoolean(compaction.enabled, config.compaction.enabled);
    config.compaction.auto = readBoolean(compaction.auto, config.compaction.auto);
    config.compaction.threshold = Math.min(
      0.95,
      readNumber(compaction.threshold, config.compaction.threshold, 0.25),
    );
    config.compaction.keepRecentMessages = readNumber(
      compaction.keepRecentMessages,
      config.compaction.keepRecentMessages,
      2,
    );
    config.compaction.minMessages = readNumber(
      compaction.minMessages,
      config.compaction.minMessages,
      4,
    );
    config.compaction.maxSummaryChars = readNumber(
      compaction.maxSummaryChars,
      config.compaction.maxSummaryChars,
      1_000,
    );
    config.compaction.numPredict = readNumber(
      compaction.numPredict,
      config.compaction.numPredict,
      128,
    );
    config.compaction.promptFile =
      typeof compaction.promptFile === "string" && compaction.promptFile.trim()
        ? compaction.promptFile.trim()
        : config.compaction.promptFile;
  }

  if (isObject(raw.goal)) {
    config.goal.enabled = readBoolean(raw.goal.enabled, config.goal.enabled);
    config.goal.provider = typeof raw.goal.provider === "string" && raw.goal.provider.trim() ? raw.goal.provider.trim() : null;
    config.goal.model = typeof raw.goal.model === "string" && raw.goal.model.trim() ? raw.goal.model.trim() : null;
    config.goal.numPredict = Math.round(readNumber(raw.goal.numPredict, config.goal.numPredict, 64));
    config.goal.maxContinuations = Math.min(10, Math.round(readNumber(raw.goal.maxContinuations, config.goal.maxContinuations, 1)));
  }

  if (isObject(raw.ui)) {
    if (raw.ui.theme === "dark" || raw.ui.theme === "light") config.ui.theme = raw.ui.theme;
    config.ui.showReasoning = readBoolean(raw.ui.showReasoning, config.ui.showReasoning);
    config.ui.showToolOutput = readBoolean(raw.ui.showToolOutput, config.ui.showToolOutput);
    config.ui.mouse = readBoolean(raw.ui.mouse, config.ui.mouse);
  }

  if (isObject(raw.session)) {
    config.session.autoTitle = readBoolean(raw.session.autoTitle, config.session.autoTitle);
  }

  if (isObject(raw.mcp)) {
    config.mcp.enabled = readBoolean(raw.mcp.enabled, config.mcp.enabled);
    if (isObject(raw.mcp.servers)) {
      for (const [name, value] of Object.entries(raw.mcp.servers)) {
        if (!isObject(value) || typeof value.command !== "string" || !value.command.trim()) continue;
        config.mcp.servers[name] = {
          enabled: readBoolean(value.enabled, true),
          command: value.command.trim(),
          args: readStringArray(value.args, []),
          env: isObject(value.env) ? Object.fromEntries(Object.entries(value.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {},
          cwd: typeof value.cwd === "string" && value.cwd.trim() ? value.cwd.trim() : undefined,
          safe: readBoolean(value.safe, true),
        };
      }
    }
  }

  return config;
}

function parseSampling(value: unknown, fallback: SamplingConfig["profile"]): SamplingConfig {
  if (!isObject(value)) return { profile: fallback };
  const profile = ["auto", "model", "qwen3-thinking", "qwen3-fast", "custom"].includes(String(value.profile))
    ? value.profile as SamplingConfig["profile"] : fallback;
  const optional = (key: string): number | undefined => typeof value[key] === "number" && Number.isFinite(value[key]) ? value[key] as number : undefined;
  return { profile, temperature: optional("temperature"), topP: optional("topP"), topK: optional("topK"), minP: optional("minP"), repeatPenalty: optional("repeatPenalty"), presencePenalty: optional("presencePenalty") };
}

function applyEnvironment(config: Config): void {
  const provider = process.env.TINYCODE_PROVIDER?.trim();
  if (provider && (provider === "llama.cpp" || provider === "ollama" || config.providers[provider])) {
    if (config.provider !== provider) config.model = config.providerModels[provider] ?? "";
    config.provider = provider;
  }
  const model = process.env.TINYCODE_MODEL?.trim();
  if (model) config.model = model;
  const llamaUrl = process.env.TINYCODE_LLAMA_URL;
  if (llamaUrl?.trim()) config.llama.baseUrl = normalizeBaseUrl(llamaUrl);
  const executable = process.env.TINYCODE_LLAMA_EXECUTABLE?.trim();
  if (executable) config.llama.executable = executable;

  // Ollama itself uses OLLAMA_HOST=127.0.0.1:11434 (without a scheme).
  const baseUrl = process.env.TINYCODE_OLLAMA_URL ?? process.env.OLLAMA_HOST;
  if (baseUrl?.trim()) config.ollama.baseUrl = normalizeBaseUrl(baseUrl);
}

export interface LoadedConfig {
  /** Effective config with environment overrides applied. */
  config: Config;
  /** Config as read from disk, without environment overrides. Persist this one. */
  fileConfig: Config;
  path: string;
  created: boolean;
}

export async function loadConfig(): Promise<LoadedConfig> {
  const file = configFile();
  const exists = await pathExists(file);
  let raw: unknown = null;
  if (exists) {
    raw = await readJson<unknown>(file);
  } else {
    await writeJsonAtomic(file, defaultConfig());
  }
  const fileConfig = mergeConfig(raw);
  const config = structuredClone(fileConfig);
  applyEnvironment(config);
  return { config, fileConfig, path: file, created: !exists };
}

export async function saveConfig(config: Config): Promise<void> {
  await writeJsonAtomic(configFile(), config);
}
