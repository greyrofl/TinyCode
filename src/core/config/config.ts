import { configFile } from "../../util/paths.js";
import { pathExists, readJson, writeJsonAtomic } from "../../util/fs.js";

export type ThemeName = "dark" | "light";

export interface Config {
  /** Default model id as understood by Ollama, e.g. "qwen2.5-coder:7b". */
  model: string;
  models: Record<string, { thinking: string; numCtx: number }>;
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
  };
  context: {
    /** Keep at most this many messages in the prompt. */
    maxMessages: number;
    /** Keep at most this many characters from the newest messages. */
    maxChars: number;
  };
  tools: {
    /** Enable the agent loop, system prompt and tool calls. */
    enabled: boolean;
    /** Skip approval for file writes, deletes and commands. */
    autoApprove: boolean;
    /** Maximum model turns in one user request. */
    maxIterations: number;
    commandTimeoutMs: number;
    maxOutputChars: number;
    /** Optional path to a custom system prompt file. */
    promptFile: string | null;
    maxStalledSteps: number;
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
}

export function defaultConfig(): Config {
  return {
    model: "qwen2.5-coder:7b",
    models: {},
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
    },
    context: {
      maxMessages: 24,
      maxChars: 24_000,
    },
    tools: {
      enabled: true,
      autoApprove: false,
      maxIterations: 16,
      commandTimeoutMs: 120_000,
      maxOutputChars: 24_000,
      promptFile: null,
      maxStalledSteps: 3,
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
    ui: {
      theme: "dark",
      showReasoning: true,
      showToolOutput: true,
      mouse: true,
    },
    session: {
      autoTitle: true,
    },
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

  if (typeof raw.model === "string" && raw.model.trim()) config.model = raw.model.trim();

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
  }

  if (isObject(raw.models)) {
    for (const [id, preference] of Object.entries(raw.models)) {
      if (!isObject(preference)) continue;
      config.models[id] = {
        thinking: readString(preference.thinking, config.generation.thinking),
        numCtx: Math.round(readNumber(preference.numCtx, config.generation.numCtx, 256)),
      };
    }
  }

  if (isObject(raw.context)) {
    config.context.maxMessages = readNumber(raw.context.maxMessages, config.context.maxMessages, 1);
    config.context.maxChars = readNumber(raw.context.maxChars, config.context.maxChars, 256);
  }

  if (isObject(raw.tools)) {
    const tools = raw.tools;
    config.tools.enabled = readBoolean(tools.enabled, config.tools.enabled);
    config.tools.autoApprove = readBoolean(tools.autoApprove, config.tools.autoApprove);
    config.tools.maxIterations = readNumber(tools.maxIterations, config.tools.maxIterations, 1);
    config.tools.commandTimeoutMs = readNumber(tools.commandTimeoutMs, config.tools.commandTimeoutMs, 1_000);
    config.tools.maxOutputChars = readNumber(tools.maxOutputChars, config.tools.maxOutputChars, 1_000);
    config.tools.maxStalledSteps = Math.round(readNumber(tools.maxStalledSteps, config.tools.maxStalledSteps, 1));
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

  if (isObject(raw.ui)) {
    if (raw.ui.theme === "dark" || raw.ui.theme === "light") config.ui.theme = raw.ui.theme;
    config.ui.showReasoning = readBoolean(raw.ui.showReasoning, config.ui.showReasoning);
    config.ui.showToolOutput = readBoolean(raw.ui.showToolOutput, config.ui.showToolOutput);
    config.ui.mouse = readBoolean(raw.ui.mouse, config.ui.mouse);
  }

  if (isObject(raw.session)) {
    config.session.autoTitle = readBoolean(raw.session.autoTitle, config.session.autoTitle);
  }

  return config;
}

function applyEnvironment(config: Config): void {
  const model = process.env.TINYCODE_MODEL?.trim();
  if (model) config.model = model;

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
