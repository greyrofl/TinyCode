#!/usr/bin/env node
import process from "node:process";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { Bus } from "./core/bus.js";
import { ChatService } from "./core/chat.js";
import { loadConfig, saveConfig, type Config } from "./core/config/config.js";
import { loadCompactionPrompt } from "./core/prompt/compact.js";
import { loadSystemPrompt, type SystemPromptInfo } from "./core/prompt/system.js";
import { createLocalEngines, type LocalEngines } from "./core/engines.js";
import { SessionStore } from "./core/session/store.js";
import { resolveToolProfile } from "./core/tool-profile.js";
import { attachMcpTools, type McpConnectionResult } from "./mcp/manager.js";
import { createDefaultTools, type ToolRegistry } from "./tools/registry.js";
import type { ToolApprovalRequest } from "./tools/types.js";
import { displayWidth, padEndWidth } from "./util/ansi.js";
import { errorMessage } from "./util/errors.js";
import { ensureDir } from "./util/fs.js";
import { sessionsDir, shortPath } from "./util/paths.js";
import { sanitizeText } from "./util/text.js";
import { relativeTime, formatBytes } from "./util/time.js";
import { version } from "./version.js";

interface ParsedArgs {
  command: string | null;
  positionals: string[];
  flags: Map<string, string | boolean>;
}

const COMMANDS = new Set([
  "run",
  "models",
  "tools",
  "sessions",
  "resume",
  "compact",
  "config",
  "doctor",
  "help",
  "version",
]);
const VALUE_FLAGS = new Set(["model", "provider", "session", "cwd", "think", "context", "profile"]);
const SHORT_FLAGS: Record<string, string> = {
  m: "model",
  s: "session",
  c: "continue",
  h: "help",
  v: "version",
  y: "yes",
};

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string | boolean>();
  const positionals: string[] = [];
  let command: string | null = null;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;

    if (arg === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }

    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const equals = body.indexOf("=");
      const key = equals === -1 ? body : body.slice(0, equals);
      let value: string | boolean = equals === -1 ? true : body.slice(equals + 1);
      if (equals === -1 && VALUE_FLAGS.has(key)) {
        const next = argv[index + 1];
        if (next !== undefined && !next.startsWith("-")) {
          value = next;
          index++;
        }
      }
      flags.set(key, value);
      continue;
    }

    if (arg.startsWith("-") && arg.length > 1) {
      const short = arg.slice(1);
      const key = SHORT_FLAGS[short];
      if (!key) {
        flags.set(short, true);
        continue;
      }
      if (VALUE_FLAGS.has(key)) {
        const next = argv[index + 1];
        if (next !== undefined && !next.startsWith("-")) {
          flags.set(key, next);
          index++;
        } else {
          flags.set(key, true);
        }
      } else {
        flags.set(key, true);
      }
      continue;
    }

    if (!command && COMMANDS.has(arg)) {
      command = arg;
      continue;
    }
    positionals.push(arg);
  }

  return { command, positionals, flags };
}

function flagValue(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags.get(name);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function flagBool(parsed: ParsedArgs, name: string): boolean {
  return parsed.flags.get(name) === true || parsed.flags.get(name) === "true";
}

function resolveCwd(parsed: ParsedArgs): string {
  const value = flagValue(parsed, "cwd");
  return value ? path.resolve(value) : process.cwd();
}

function usage(): string {
  return `tinycode ${version()} — a terminal agent for small local models

Usage
  tinycode [options]                 interactive TUI
  tinycode run [options] [prompt]    one-shot response (reads stdin when piped)
  tinycode resume [session]          open an existing session (latest by default)
  tinycode compact [session]         compact older turns into durable memory
  tinycode models [--json]           list models for the selected engine
  tinycode tools [--json]            list agent tools and approval level
  tinycode sessions [--json]         list saved sessions
  tinycode config [--path|--json]    show the config file
  tinycode doctor                    check the selected engine and local state

Options
  -m, --model <name>    model to use for this run
      --provider <id>   llama.cpp, ollama, or a configured compatible provider
  -s, --session <id>    open a specific session
  -c, --continue        continue the most recent session
  -y, --yes             auto-approve commands and restricted MCP tools
      --thinking        stream thinking to stderr in run mode
      --think <mode>    generation mode: off, on, auto, or a supported named level
      --context <n>     physical engine context size for this session
      --profile <name>  tools: auto, plan, edit, full; model restores size-based default
      --cwd <dir>       working directory recorded in the session
      --json            machine-readable output for models/sessions/config
  -h, --help            show this help
  -v, --version         show the version

Environment
  TINYCODE_HOME         state directory (default: ~/.tinytcode)
  TINYCODE_MODEL        default model, overrides the config file
  TINYCODE_PROVIDER     engine/provider id, overrides the config file
  TINYCODE_LLAMA_URL    llama-server base URL (default: 127.0.0.1:8081)
  TINYCODE_LLAMA_EXECUTABLE  installed llama-server binary
  TINYCODE_OLLAMA_URL   Ollama base URL, overrides the config file
  TINYCODE_PROMPT       custom system prompt file
  OLLAMA_HOST           also read when TINYCODE_OLLAMA_URL is not set
`;
}

function printHelp(): void {
  process.stdout.write(usage());
}

interface Bootstrapped {
  loaded: Awaited<ReturnType<typeof loadConfig>>;
  bus: Bus;
  chat: ChatService;
  provider: LocalEngines;
  store: SessionStore;
  tools: ToolRegistry;
  prompt: SystemPromptInfo;
  compactionPrompt: SystemPromptInfo;
  runtime: LocalEngines;
  mcp: McpConnectionResult;
}

async function bootstrap(parsed: ParsedArgs): Promise<Bootstrapped> {
  const loaded = await loadConfig();
  const engine = flagValue(parsed, "provider");
  if (engine) {
    if (engine !== "llama.cpp" && engine !== "ollama" && !loaded.config.providers[engine]) throw new Error(`Unknown provider: ${engine}. Configure it under providers or use llama.cpp/ollama.`);
    if (engine !== loaded.config.provider) loaded.config.model = loaded.config.providerModels[engine] ?? "";
    loaded.config.provider = engine;
  }
  if (flagBool(parsed, "yes")) loaded.config.tools.autoApprove = true;
  const profile = flagValue(parsed, "profile");
  if (profile) {
    if (!["model", "auto", "plan", "edit", "full"].includes(profile)) throw new Error(`Unknown tool profile: ${profile}`);
    loaded.config.tools.profile = profile === "model" ? "auto" : profile as Config["tools"]["profile"];
    loaded.config.tools.profileByModel = profile === "model";
  }

  const tools = createDefaultTools();
  const cwd = resolveCwd(parsed);
  const mcp = await attachMcpTools(tools, loaded.config, cwd);
  const prompt = loadSystemPrompt(tools.definitions(), loaded.config);
  const compactionPrompt = loadCompactionPrompt(loaded.config);

  const bus = new Bus();
  const provider = createLocalEngines(loaded.config, cwd, (text) => bus.emit("notice", { text, level: "info" }));
  const store = new SessionStore();
  const chat = new ChatService({
    config: loaded.config,
    provider,
    store,
    bus,
    cwd,
    tools,
    systemPrompt: prompt.text,
    compactionPrompt: compactionPrompt.text,
  });
  const runtime = provider;
  return { loaded, bus, chat, provider, store, tools, prompt, compactionPrompt, runtime, mcp };
}

async function prepareRuntime(runtime: LocalEngines, signal?: AbortSignal): Promise<void> {
  if (!(await runtime.available())) process.stderr.write(`Preparing ${runtime.name} / local startup if allowed…\n`);
  await runtime.ensureStarted(signal);
}

async function applySessionFlags(chat: ChatService, parsed: ParsedArgs): Promise<void> {
  const provider = flagValue(parsed, "provider");
  if (provider && chat.currentProvider !== provider) await chat.setProvider(provider);
  const model = flagValue(parsed, "model");
  if (model && chat.currentModel !== model) await chat.setModel(model);
  const thinking = flagValue(parsed, "think");
  if (thinking) await chat.setThinking(thinking);
  const context = flagValue(parsed, "context");
  if (context) await chat.setContextSize(Number(context));
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function runTui(parsed: ParsedArgs, sessionId?: string): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write("Interactive mode needs a TTY. Use `tinycode run \"...\"` for one-shot prompts.\n");
    return 1;
  }

  const { loaded, bus, chat, prompt, compactionPrompt, tools, runtime, mcp } = await bootstrap(parsed);
  const cwd = resolveCwd(parsed);
  const requestedSession = sessionId ?? flagValue(parsed, "session");

  try {
    await chat.initialize({
      sessionId: requestedSession,
      continue: flagBool(parsed, "continue"),
      model: flagValue(parsed, "model"),
      cwd,
    });
    await applySessionFlags(chat, parsed);
  } catch (error) {
    tools.dispose();
    await runtime.dispose();
    process.stderr.write(`${errorMessage(error)}\n`);
    return 1;
  }

  const { TinyCodeTui } = await import("./tui/app.js");
  const tui = new TinyCodeTui({
    chat,
    bus,
    config: loaded.config,
    persistedConfig: loaded.fileConfig,
    configPath: loaded.path,
    cwd,
    promptSource: prompt.source,
    compactionPromptSource: compactionPrompt.source,
    runtime,
    startupNotices: [
      ...mcp.connected.map((text) => ({ text: `MCP connected: ${text}`, level: "info" as const })),
      ...mcp.errors.map((text) => ({ text: `MCP unavailable: ${text}`, level: "warn" as const })),
    ],
    onModelChange: async (model) => {
      loaded.config.model = model;
      loaded.fileConfig.model = model;
      loaded.fileConfig.provider = loaded.config.provider;
      loaded.fileConfig.providerModels[loaded.config.provider] = model;
      await saveConfig(loaded.fileConfig);
    },
  });
  try {
    await tui.run();
  } finally {
    tools.dispose();
    await runtime.dispose();
  }
  return 0;
}

async function runOnce(parsed: ParsedArgs): Promise<number> {
  let prompt = parsed.positionals.join(" ").trim();
  if ((!prompt || prompt === "-") && !process.stdin.isTTY) prompt = (await readStdin()).trim();
  if (!prompt) {
    process.stderr.write('Usage: tinycode run [--model NAME] "prompt"\n');
    return 1;
  }

  const { loaded, bus, chat, tools, runtime } = await bootstrap(parsed);
  const cwd = resolveCwd(parsed);
  try {
    await chat.initialize({
      sessionId: flagValue(parsed, "session"),
      continue: flagBool(parsed, "continue"),
      model: flagValue(parsed, "model"),
      cwd,
    });
    await applySessionFlags(chat, parsed);
    const parallel = await runtime.parallelStatus();
    if (parallel.local && parallel.value !== null && parallel.value !== 1) {
      process.stderr.write(`Warning: ${runtime.name} parallel=${parallel.value}; use 1 for a single coding agent (TUI: /parallel).\n`);
    }
  } catch (error) {
    tools.dispose();
    await runtime.dispose();
    process.stderr.write(`${errorMessage(error)}\n`);
    return 1;
  }

  let warnedApproval = false;
  chat.setApprovalHandler(async (request: ToolApprovalRequest) => {
    if (loaded.config.tools.autoApprove) return true;
    if (!process.stdin.isTTY) {
      if (!warnedApproval) {
        warnedApproval = true;
        process.stderr.write(
          `\nApproval required for ${request.tool}. Re-run with --yes to allow commands and restricted MCP tools.\n`,
        );
      }
      return false;
    }

    const readline = createInterface({ input: process.stdin, output: process.stderr });
    try {
      process.stderr.write("\n");
      const answer = await readline.question(
        `Allow ${request.tool}? ${request.summary}\n[y/N] `,
      );
      return /^y(es)?$/i.test(answer.trim());
    } catch {
      return false;
    } finally {
      readline.close();
    }
  });

  const showThinking = flagBool(parsed, "thinking");
  let wroteOutput = false;
  let wroteThinking = false;
  let lastChunk = "";
  let lastThinking = "";

  const unsubscribeThinking = bus.on("message.delta", ({ part, delta }) => {
    if (part !== "reasoning" || !showThinking) return;
    const text = process.stderr.isTTY ? `\x1b[2m${delta}\x1b[0m` : delta;
    process.stderr.write(text);
    wroteThinking = true;
    lastThinking = delta;
  });

  const unsubscribeTools = bus.on("message.updated", ({ part }) => {
    if (part.type !== "tool") return;
    if (part.status === "running") {
      const title = part.title ? ` · ${part.title.split("\n")[0]}` : "";
      process.stderr.write(`⚙ ${part.tool}${title}\n`);
    } else if (part.status === "completed") {
      process.stderr.write(`✔ ${part.tool}\n`);
    } else if (part.status === "denied") {
      process.stderr.write(`⊘ ${part.tool} denied\n`);
    } else if (part.status === "error") {
      const detail = part.error ? `: ${part.error.split("\n")[0]}` : "";
      process.stderr.write(`✖ ${part.tool}${detail}\n`);
    }
  });

  const unsubscribe = bus.on("message.delta", ({ part, delta }) => {
    if (part === "text") {
      process.stdout.write(delta);
      wroteOutput = true;
      lastChunk = delta;
    }
  });
  const unsubscribeNotices = bus.on("notice", ({ text }) => process.stderr.write(`${text}\n`));
  const onSigint = (): void => chat.abort(true);
  process.once("SIGINT", onSigint);

  try {
    await chat.send(prompt, async (signal) => {
      if (!chat.currentModel) throw new Error("Select a model first: tinycode --provider llama.cpp --model <path.gguf>, or use /models in the TUI. No weights are downloaded automatically.");
      await prepareRuntime(runtime, signal);
      if (chat.currentProvider === "llama.cpp") await chat.loadCurrentModel(signal, chat.contextLimit);
    });
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    return 1;
  } finally {
    process.off("SIGINT", onSigint);
    unsubscribe();
    unsubscribeThinking();
    unsubscribeTools();
    unsubscribeNotices();
    tools.dispose();
    await runtime.dispose();
  }

  const messages = chat.current?.messages ?? [];
  const last = messages[messages.length - 1];
  if (wroteThinking && !lastThinking.endsWith("\n")) process.stderr.write("\n");
  if (last?.aborted) {
    process.stderr.write("\nAborted.\n");
    return 130;
  }
  if (last?.error) {
    process.stderr.write(`\nError: ${last.error}\n`);
    return 1;
  }
  if (last?.outcome === "blocked") {
    process.stderr.write("\nTask is blocked, not completed.\n");
    return 1;
  }
  // The answer may not end with a newline; keep the shell prompt tidy.
  if (wroteOutput && !lastChunk.endsWith("\n")) process.stdout.write("\n");
  return 0;
}

function printTable(headers: string[], rows: string[][]): void {
  const cleanRows = rows.map((row) => row.map((cell) => sanitizeText(cell)));
  const widths = headers.map((header, index) =>
    Math.max(displayWidth(header), ...cleanRows.map((row) => displayWidth(row[index] ?? ""))),
  );
  const format = (row: string[]): string =>
    row
      .map((cell, index) => padEndWidth(cell, widths[index]!))
      .join("  ")
      .trimEnd();
  process.stdout.write(`${format(headers)}\n`);
  process.stdout.write(`${widths.map((width) => "─".repeat(width)).join("  ")}\n`);
  for (const row of cleanRows) process.stdout.write(`${format(row)}\n`);
}

async function listModels(parsed: ParsedArgs): Promise<number> {
  const { loaded, provider, runtime, tools } = await bootstrap(parsed);
  let models;
  try {
    if (provider.id === "ollama") await prepareRuntime(runtime);
    models = await provider.listModels();
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    return 1;
  } finally {
    tools.dispose(); await runtime.dispose();
  }

  if (flagBool(parsed, "json")) {
    process.stdout.write(`${JSON.stringify(models, null, 2)}\n`);
    return 0;
  }

  if (models.length === 0) {
    process.stdout.write(provider.id === "llama.cpp"
      ? "No local GGUFs found. Put a model in ~/.tinytcode/models, configure llama.modelDirs, or use --model <path.gguf>. Weights are not downloaded automatically.\n"
      : "No models found. Pull one first, for example:\n  ollama pull qwen2.5-coder:7b\n");
    return 0;
  }

  const rows = models.map((model) => [
    model.id === loaded.config.model ? `${model.id} *` : model.id,
    model.parameterSize ?? "-",
    model.quantization ?? "-",
    formatBytes(model.sizeBytes),
  ]);
  printTable(["MODEL", "PARAMS", "QUANT", "SIZE"], rows);
  process.stdout.write("\n* default model in the config\n");
  return 0;
}

async function listTools(parsed: ParsedArgs): Promise<number> {
  const registry = createDefaultTools();
  try {
    const definitions = registry.definitions().map((definition) => ({
      name: definition.name,
      approval: definition.safe ? "automatic" : "required",
      description: definition.description,
      parameters: definition.parameters,
    }));
    if (flagBool(parsed, "json")) {
      process.stdout.write(`${JSON.stringify(definitions, null, 2)}\n`);
      return 0;
    }
    printTable(
      ["TOOL", "APPROVAL", "DESCRIPTION"],
      definitions.map((definition) => [
        definition.name,
        definition.approval,
        definition.description.length > 72
          ? `${definition.description.slice(0, 71)}…`
          : definition.description,
      ]),
    );
    return 0;
  } finally {
    registry.dispose();
  }
}

async function listSessions(parsed: ParsedArgs): Promise<number> {
  const store = new SessionStore();
  const sessions = await store.list();
  if (flagBool(parsed, "json")) {
    process.stdout.write(`${JSON.stringify(sessions, null, 2)}\n`);
    return 0;
  }
  if (sessions.length === 0) {
    process.stdout.write("No sessions yet. Run `tinycode` to start one.\n");
    return 0;
  }
  const rows = sessions.map((session) => [
    session.id,
    session.title.length > 42 ? `${session.title.slice(0, 41)}…` : session.title,
    session.model,
    String(session.messageCount),
    relativeTime(session.updatedAt),
  ]);
  printTable(["SESSION", "TITLE", "MODEL", "MESSAGES", "UPDATED"], rows);
  return 0;
}

async function compactSessionCommand(parsed: ParsedArgs): Promise<number> {
  const { chat, runtime, tools } = await bootstrap(parsed);
  const requested = parsed.positionals[0] ?? flagValue(parsed, "session");
  const sessionId = requested ?? (await chat.listSessions())[0]?.id;
  if (!sessionId) {
    process.stderr.write("No saved sessions to compact.\n");
    tools.dispose(); await runtime.dispose();
    return 1;
  }
  try {
    await chat.initialize({ sessionId, cwd: resolveCwd(parsed) });
    await applySessionFlags(chat, parsed);
    await prepareRuntime(runtime);
    const result = await chat.compact();
    if (flagBool(parsed, "json")) {
      process.stdout.write(`${JSON.stringify({ sessionId, ...result }, null, 2)}\n`);
    } else if (result.compacted) {
      process.stdout.write(
        `Compacted ${result.sourceMessages} messages into ${result.summaryChars} characters (${result.strategy}).\n`,
      );
    } else {
      process.stdout.write(`Nothing compacted: ${result.reason}\n`);
    }
    return 0;
  } catch (error) {
    process.stderr.write(`Compaction failed: ${errorMessage(error)}\n`);
    return 1;
  } finally {
    tools.dispose(); await runtime.dispose();
  }
}

async function showConfig(parsed: ParsedArgs): Promise<number> {
  const loaded = await loadConfig();
  if (flagBool(parsed, "path")) {
    process.stdout.write(`${loaded.path}\n`);
    return 0;
  }
  if (flagBool(parsed, "json")) {
    process.stdout.write(`${JSON.stringify(loaded.config, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`Config: ${loaded.path}${loaded.created ? " (created with defaults)" : ""}\n\n`);
  process.stdout.write(`${JSON.stringify(loaded.config, null, 2)}\n`);
  return 0;
}

async function doctor(parsed: ParsedArgs): Promise<number> {
  const loaded = await loadConfig();
  const engine = flagValue(parsed, "provider");
  if (engine) {
    if (engine !== "llama.cpp" && engine !== "ollama" && !loaded.config.providers[engine]) throw new Error("Unknown provider. Configure it under providers or use llama.cpp/ollama.");
    if (engine !== loaded.config.provider) loaded.config.model = loaded.config.providerModels[engine] ?? "";
    loaded.config.provider = engine;
  }
  const provider = createLocalEngines(loaded.config, resolveCwd(parsed));
  const health = await provider.health();
  const tools = createDefaultTools();
  const prompt = loadSystemPrompt(tools.definitions(), loaded.config);
  const compactPrompt = loadCompactionPrompt(loaded.config);
  const parallel = await provider.parallelStatus();
  const lines: string[] = [
    `tinycode  ${version()}`,
    `node      ${process.version} (${process.platform}/${process.arch})`,
    `config    ${shortPath(loaded.path)}${loaded.created ? " (created)" : ""}`,
    `sessions  ${shortPath(sessionsDir())}`,
    `engine    ${provider.name}`,
    `server    ${provider.id === "llama.cpp" ? loaded.config.llama.baseUrl : provider.id === "ollama" ? loaded.config.ollama.baseUrl : loaded.config.providers[provider.id]?.baseUrl ?? "unknown"}`,
    provider.id === "llama.cpp" ? `autoinstall ${loaded.config.llama.autoInstall ? "verified official binaries on first load" : "disabled"}`
      : provider.id === "ollama" ? `autostart ${loaded.config.ollama.autoStart ? "enabled (local only)" : "disabled"}`
        : "runtime   user-owned external API",
    `parallel  ${parallel.value ?? "unknown"} · ${parallel.source}`,
    `tools     ${tools.size}${loaded.config.tools.enabled ? "" : " (disabled)"} · approval ${
      loaded.config.tools.autoApprove ? "auto" : "ask"
    }`,
    `profile   ${resolveToolProfile(loaded.config, loaded.config.model)}`,
    `mcp       ${Object.values(loaded.config.mcp.servers).filter((server) => server.enabled).length} configured`,
    `prompt    ${prompt.usedFallback ? "built-in fallback" : shortPath(prompt.source)}`,
    `compact   ${loaded.config.compaction.enabled ? `${loaded.config.compaction.auto ? "auto" : "manual"} · ${(loaded.config.compaction.threshold * 100).toFixed(0)}%` : "disabled"} · ${compactPrompt.usedFallback ? "built-in prompt" : shortPath(compactPrompt.source)}`,
  ];

  let code = 0;
  if (health.ok) {
    lines.push(`status    ok${health.version ? ` (${provider.name} ${health.version})` : ""}`);
    try {
      await ensureDir(sessionsDir());
      const models = await provider.listModels();
      lines.push(`models    ${models.length}`);
      const hasDefault = models.some((model) => model.id === loaded.config.model);
      lines.push(`default   ${loaded.config.model || "not selected"}${hasDefault ? "" : " (not in model list)"}`);
      if (!hasDefault) code = 1;
    } catch (error) {
      lines.push(`models    failed: ${errorMessage(error)}`);
      code = 1;
    }
  } else {
    lines.push("status    failed");
    lines.push(`error     ${health.error ?? "unknown error"}`);
    code = 1;
  }

  process.stdout.write(`${lines.join("\n")}\n`);
  tools.dispose(); await provider.dispose();
  return code;
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));

  if (flagBool(parsed, "version") || parsed.command === "version") {
    process.stdout.write(`${version()}\n`);
    return 0;
  }
  if (flagBool(parsed, "help") || parsed.command === "help") {
    printHelp();
    return 0;
  }

  if (!parsed.command) {
    if (parsed.positionals.length > 0) {
      process.stderr.write(`Unknown command: ${parsed.positionals[0]}\n\n`);
      printHelp();
      return 1;
    }
    return runTui(parsed);
  }

  switch (parsed.command) {
    case "run":
      return runOnce(parsed);
    case "models":
      return listModels(parsed);
    case "tools":
      return listTools(parsed);
    case "sessions":
      return listSessions(parsed);
    case "compact":
      return compactSessionCommand(parsed);
    case "resume": {
      const explicit = parsed.positionals[0] ?? flagValue(parsed, "session");
      if (explicit) return runTui(parsed, explicit);
      const latest = (await new SessionStore().list())[0];
      if (!latest) {
        process.stderr.write("No saved sessions yet. Run `tinycode` to start one.\n");
        return 1;
      }
      return runTui(parsed, latest.id);
    }
    case "config":
      return showConfig(parsed);
    case "doctor":
      return doctor(parsed);
    default:
      printHelp();
      return 1;
  }
}

process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(0);
});

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`Error: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
