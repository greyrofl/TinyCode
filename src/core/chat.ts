import type { Config } from "./config/config.js";
import path from "node:path";
import {
  activeMessages,
  compactedMemory,
  contextUsageRatio,
  fallbackSummary,
  normalizeSummary,
  planCompaction,
  type CompactionResult,
} from "./compaction.js";
import { buildContext } from "./context.js";
import type { Bus } from "./bus.js";
import { errorMessage } from "../util/errors.js";
import { newMessageId, newToolCallId } from "../util/id.js";
import { truncateWidth } from "../util/ansi.js";
import { singleLine } from "../util/text.js";
import type { ChatMessage, ModelDetails, ModelInfo, Provider } from "./provider/types.js";
import { thinkingValue } from "./provider/model-details.js";
import { loadProjectInstructions } from "./project-instructions.js";
import type { SessionStore } from "./session/store.js";
import type { Message, Session, SessionMeta, TextPart, ToolPart } from "./session/types.js";
import { textOf } from "./session/types.js";
import { mergeUsage, type ChatStatus, type ContextUsage } from "./types.js";
import { looksLikePlan, reportsBlocked, taskRequirements } from "./task-guard.js";
import { isVerificationCommand, verificationKinds } from "../tools/change-feedback.js";
import { parseToolCalls, ToolCallStreamFilter, type ParsedToolCall } from "../tools/parse.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { Tool, ToolApprovalHandler, ToolApprovalRequest } from "../tools/types.js";

export interface ChatServiceOptions {
  config: Config;
  provider: Provider;
  store: SessionStore;
  bus: Bus;
  cwd: string;
  tools?: ToolRegistry;
  systemPrompt?: string;
  compactionPrompt?: string;
}

export interface InitializeOptions {
  sessionId?: string;
  continue?: boolean;
  model?: string;
  cwd?: string;
}

function titleFrom(text: string): string {
  return truncateWidth(singleLine(text), 58);
}

function safeSummary(tool: Tool, input: Record<string, unknown>): string {
  try {
    const summary = tool.definition.summary(input);
    return summary.trim() || tool.definition.name;
  } catch {
    return tool.definition.name;
  }
}

function canonicalFile(cwd: string, file: string): string {
  const absolute = path.resolve(cwd, file);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

const PROJECT_MUTATING_TOOLS = new Set([
  "create_file",
  "replace_file",
  "edit_file",
  "apply_patch",
  "delete_file",
  "delete_directory",
  "move_path",
  "copy_path",
  "execute_command",
]);

/**
 * Owns the active session and the generation lifecycle, including the tool
 * loop. The model protocol is text-based (`<tool_call>...`): small models are
 * much more reliable with it than with native JSON tool calls.
 */
export class ChatService {
  private readonly config: Config;
  private readonly provider: Provider;
  private readonly store: SessionStore;
  private readonly bus: Bus;
  private readonly tools: ToolRegistry | null;
  private readonly systemPromptTemplate: string;
  private readonly compactionPrompt: string;
  private cwd: string;

  private session: Session | null = null;
  private controller: AbortController | null = null;
  private pending: Promise<void> | null = null;
  private currentStatus: ChatStatus = { state: "idle" };
  private approvalHandler: ToolApprovalHandler | null = null;
  private readonly projectInstructionCache = new Map<string, string>();
  private readonly modelDetailsCache = new Map<string, ModelDetails>();
  private liveContext: { input: number; output: number; outputChars: number; estimated: boolean } | null = null;

  constructor(options: ChatServiceOptions) {
    this.config = options.config;
    this.provider = options.provider;
    this.store = options.store;
    this.bus = options.bus;
    this.cwd = options.cwd;
    this.tools = options.tools ?? null;
    this.systemPromptTemplate = options.systemPrompt ?? "";
    this.compactionPrompt = options.compactionPrompt ?? "";
  }

  get current(): Session | null {
    return this.session;
  }

  get status(): ChatStatus {
    return this.currentStatus;
  }

  get busy(): boolean {
    return this.pending !== null;
  }

  get currentModel(): string | null {
    return this.session?.meta.model ?? null;
  }

  get currentThinking(): string {
    return this.session?.meta.thinking ?? this.config.models[this.currentModel ?? ""]?.thinking ?? this.config.generation.thinking;
  }

  get contextLimit(): number {
    return this.session?.meta.numCtx ?? this.config.models[this.currentModel ?? ""]?.numCtx ?? this.config.generation.numCtx;
  }

  get contextUsage(): ContextUsage {
    let input = 0;
    let output = 0;
    let estimated = true;
    if (this.liveContext) {
      ({ input, output, estimated } = this.liveContext);
    } else if (this.session?.meta.lastContext) {
      input = this.session.meta.lastContext.inputTokens;
      output = this.session.meta.lastContext.generatedTokens;
      estimated = false;
    } else if (this.session) {
      const prompt = this.toolsEnabled ? this.systemPromptFor(this.session) : compactedMemory(this.session);
      const messages = buildContext(activeMessages(this.session), this.contextBudget(prompt), prompt);
      input = messages.reduce((sum, message) => sum + Math.ceil(message.content.length / 4) + 8, 3);
    }
    const tokens = input + output;
    return { tokens, inputTokens: input, outputTokens: output, maxTokens: this.contextLimit, percent: Math.round(tokens / this.contextLimit * 100), estimated };
  }

  get toolsEnabled(): boolean {
    return this.config.tools.enabled && this.tools !== null && this.tools.size > 0;
  }

  get toolCount(): number {
    return this.tools?.size ?? 0;
  }

  get toolDefinitions() {
    return this.tools?.definitions() ?? [];
  }

  get contextCompaction(): SessionMeta["compaction"] {
    return this.session?.meta.compaction;
  }

  get contextPressure(): number {
    if (!this.session) return 0;
    return contextUsageRatio(
      this.session,
      { ...this.config, generation: { ...this.config.generation, numCtx: this.contextLimit } },
      this.baseSystemPromptFor(this.session).length,
    );
  }

  setApprovalHandler(handler: ToolApprovalHandler | null): void {
    this.approvalHandler = handler;
  }

  async initialize(options: InitializeOptions = {}): Promise<void> {
    if (options.cwd) this.cwd = options.cwd;

    if (options.sessionId) {
      await this.resume(options.sessionId);
      return;
    }

    if (options.continue) {
      const sessions = await this.store.list();
      const latest = sessions[0];
      if (latest) {
        await this.resume(latest.id);
        return;
      }
    }

    await this.createSession({ model: options.model ?? this.config.model, cwd: this.cwd });
  }

  async createSession(options: { model?: string; cwd?: string; title?: string } = {}): Promise<Session> {
    const session = await this.store.create({
      model: options.model ?? this.currentModel ?? this.config.model,
      cwd: options.cwd ?? this.cwd,
      title: options.title,
    });
    this.session = session;
    this.liveContext = null;
    await this.initializeModelPreferences(session);
    this.setStatus({ state: "idle" });
    this.bus.emit("session.changed", { meta: session.meta });
    return session;
  }

  async resume(id: string): Promise<Session> {
    const session = await this.store.load(id);
    this.session = session;
    this.liveContext = null;
    await this.initializeModelPreferences(session);
    this.setStatus({ state: "idle" });
    this.bus.emit("session.changed", { meta: session.meta });
    return session;
  }

  async listSessions(): Promise<SessionMeta[]> {
    return this.store.list();
  }

  async deleteSession(id: string): Promise<void> {
    if (this.busy) throw new Error("Cannot delete a session while a response is being generated.");
    await this.store.delete(id);
    if (this.session?.meta.id === id) {
      this.session = null;
      await this.createSession();
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    return this.provider.listModels();
  }

  async health(): Promise<{ ok: boolean; version?: string; error?: string }> {
    return this.provider.health();
  }

  async getModelDetails(model = this.requireSession().meta.model): Promise<ModelDetails> {
    const cached = this.modelDetailsCache.get(model);
    if (cached) return cached;
    const details = this.provider.getModelDetails ? await this.provider.getModelDetails(model) : {
      id: model,
      name: model,
      thinking: { modes: ["off"], defaultMode: "off", control: "none" as const },
    };
    this.modelDetailsCache.set(model, details);
    return details;
  }

  private async initializeModelPreferences(session: Session): Promise<void> {
    const preference = this.config.models[session.meta.model];
    session.meta.numCtx ??= preference?.numCtx ?? this.config.generation.numCtx;
    session.meta.thinking ??= preference?.thinking ?? this.config.generation.thinking;
    try {
      const details = await this.getModelDetails(session.meta.model);
      if (details.contextLength) session.meta.numCtx = Math.min(session.meta.numCtx, details.contextLength);
      if (session.meta.thinking !== "auto" && !details.thinking.modes.includes(session.meta.thinking)) {
        session.meta.thinking = details.thinking.defaultMode;
      }
    } catch { /* Missing model should not prevent opening the TUI and choosing another one. */ }
    await this.store.saveMeta(session.meta);
  }

  async setModel(model: string): Promise<void> {
    if (this.busy) throw new Error("Wait for the current generation before changing models.");
    const session = this.requireSession();
    if (session.meta.model === model) return;
    await this.getModelDetails(model);
    if (this.busy) throw new Error("Generation started while loading model information; wait and select again.");
    session.meta.model = model;
    delete session.meta.thinking;
    delete session.meta.numCtx;
    delete session.meta.lastContext;
    this.liveContext = null;
    await this.initializeModelPreferences(session);
    session.meta.updatedAt = Date.now();
    await this.store.saveMeta(session.meta);
    this.bus.emit("session.changed", { meta: session.meta });
  }

  async setThinking(mode: string): Promise<void> {
    if (this.busy) throw new Error("Cannot change thinking during generation.");
    const details = await this.getModelDetails();
    if (this.busy) throw new Error("Cannot change thinking during generation.");
    if (mode !== "auto" && !details.thinking.modes.includes(mode)) throw new Error(`Unsupported thinking mode: ${mode}`);
    this.requireSession().meta.thinking = mode;
    this.liveContext = null;
    delete this.requireSession().meta.lastContext;
    await this.store.saveMeta(this.requireSession().meta);
    this.bus.emit("session.changed", { meta: this.requireSession().meta });
  }

  async setContextSize(tokens: number): Promise<void> {
    if (this.busy) throw new Error("Cannot change context during generation.");
    if (!Number.isInteger(tokens) || tokens < 256) throw new Error("Context must be an integer of at least 256 tokens.");
    const details = await this.getModelDetails();
    if (this.busy) throw new Error("Cannot change context during generation.");
    if (tokens > (details.contextLength ?? 1_048_576)) throw new Error(`Model context limit is ${details.contextLength} tokens.`);
    const session = this.requireSession();
    session.meta.numCtx = tokens;
    delete session.meta.lastContext;
    this.liveContext = null;
    await this.store.saveMeta(session.meta);
    this.bus.emit("session.changed", { meta: session.meta });
  }

  async send(input: string): Promise<void> {
    const text = input.trim();
    if (!text) return;
    if (this.pending) throw new Error("A response is already being generated. Press Esc to abort.");

    const session = this.requireSession();
    const controller = new AbortController();
    this.controller = controller;
    this.pending = this.sendAndGenerate(session, text, controller);
    try { await this.pending; } finally { this.pending = null; this.controller = null; }
  }

  private async sendAndGenerate(session: Session, text: string, controller: AbortController): Promise<void> {
    const user: Message = {
      id: newMessageId("user"),
      role: "user",
      createdAt: Date.now(),
      parts: [{ type: "text", text }],
    };
    session.messages.push(user);
    await this.store.appendMessage(session.meta.id, user);

    if (this.config.session.autoTitle && session.meta.title === "New session") {
      session.meta.title = titleFrom(text);
    }
    session.meta.messageCount = session.messages.length;
    session.meta.updatedAt = Date.now();
    await this.store.saveMeta(session.meta);
    this.bus.emit("session.changed", { meta: session.meta });

    await this.generate(session, controller);
  }

  abort(): void {
    this.controller?.abort();
  }

  /** Resolves when the current generation has finished (or immediately if idle). */
  async waitForIdle(): Promise<void> {
    if (!this.pending) return;
    try {
      await this.pending;
    } catch {
      // Generation errors are already surfaced through message state.
    }
  }

  async retry(): Promise<void> {
    if (this.pending) throw new Error("A response is already being generated.");
    const session = this.requireSession();

    let index = -1;
    for (let i = session.messages.length - 1; i >= 0; i--) {
      if (session.messages[i]!.role === "user") {
        index = i;
        break;
      }
    }
    if (index < 0) throw new Error("Nothing to retry: there is no user message yet.");
    const controller = new AbortController();
    this.controller = controller;
    this.pending = this.retryAndGenerate(session, index, controller);
    try { await this.pending; } finally { this.pending = null; this.controller = null; }
  }

  private async retryAndGenerate(session: Session, index: number, controller: AbortController): Promise<void> {
    const kept = session.messages.slice(0, index + 1);
    session.messages = kept;
    await this.store.rewriteMessages(session.meta.id, kept);
    session.meta.messageCount = kept.length;
    session.meta.updatedAt = Date.now();
    await this.store.saveMeta(session.meta);
    this.bus.emit("session.changed", { meta: session.meta });

    await this.generate(session, controller);
  }

  async compact(): Promise<CompactionResult> {
    if (this.pending) throw new Error("Cannot compact while another operation is running.");
    if (!this.config.compaction.enabled) {
      return {
        compacted: false,
        reason: "Session compaction is disabled in the config.",
        sourceMessages: 0,
        summaryChars: this.session?.meta.compaction?.summary.length ?? 0,
      };
    }

    const session = this.requireSession();
    const controller = new AbortController();
    this.controller = controller;
    const operation = this.performCompaction(session, true, controller.signal);
    this.pending = operation.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await operation;
    } finally {
      this.pending = null;
      this.controller = null;
      this.setStatus({ state: "idle" });
    }
  }

  private requireSession(): Session {
    if (!this.session) throw new Error("No active session.");
    return this.session;
  }

  private setStatus(status: ChatStatus): void {
    this.currentStatus = status;
    this.bus.emit("status", status);
  }

  private generationOptions(): Record<string, unknown> {
    const generation = this.config.generation;
    const qwen = this.modelDetailsCache.get(this.currentModel ?? "")?.family === "qwen3";
    const usePreset = qwen && generation.temperature === 0.2 && generation.topP === 0.9;
    const thinking = this.currentThinking !== "off";
    return {
      temperature: usePreset ? thinking ? 0.6 : 0.7 : generation.temperature,
      top_p: usePreset ? thinking ? 0.95 : 0.8 : generation.topP,
      ...(usePreset ? { top_k: 20, min_p: 0 } : {}),
      num_ctx: this.contextLimit,
      num_predict: generation.numPredict,
      repeat_penalty: usePreset ? 1 : generation.repeatPenalty,
      ...(generation.seed !== null ? { seed: generation.seed } : {}),
      ...(generation.stop.length > 0 ? { stop: generation.stop } : {}),
      ...this.config.ollama.extraOptions,
    };
  }

  private baseSystemPromptFor(session: Session): string {
    const base = this.systemPromptTemplate.replaceAll("{{CWD}}", session.meta.cwd);
    let project = this.projectInstructionCache.get(session.meta.cwd);
    if (project === undefined) {
      project = loadProjectInstructions(session.meta.cwd).text;
      this.projectInstructionCache.set(session.meta.cwd, project);
    }
    return project ? `${base.trimEnd()}\n\n${project}\n` : base;
  }

  private systemPromptFor(session: Session): string {
    const base = this.baseSystemPromptFor(session);
    const memory = compactedMemory(session);
    return memory ? `${base.trimEnd()}\n\n${memory}\n` : base;
  }

  private contextBudget(systemPrompt?: string): Config["context"] {
    // Reserve output tokens and the system prompt inside Ollama's num_ctx.
    // Four chars/token is intentionally conservative for mixed code/text.
    const contextTokens = Math.max(256, this.contextLimit);
    const outputReserve = Math.min(
      Math.max(256, this.config.generation.numPredict),
      Math.floor(contextTokens / 2),
    );
    const availableCharacters = Math.max(
      1_024,
      (contextTokens - outputReserve) * 4 - (systemPrompt?.length ?? 0),
    );
    return {
      maxMessages: this.config.context.maxMessages,
      maxChars: Math.min(this.config.context.maxChars, availableCharacters),
    };
  }

  private compactionSourceBudget(session: Session): number {
    const contextChars = Math.max(4_096, this.contextLimit * 4);
    const reserve = Math.min(
      Math.max(128, this.config.compaction.numPredict) * 4,
      Math.floor(contextChars / 3),
    );
    return Math.max(
      4_000,
      contextChars - reserve - this.compactionPrompt.length - (session.meta.compaction?.summary.length ?? 0) - 1_000,
    );
  }

  private async performCompaction(
    session: Session,
    force: boolean,
    signal: AbortSignal,
  ): Promise<CompactionResult> {
    if (!this.config.compaction.enabled) {
      return { compacted: false, reason: "Compaction is disabled.", sourceMessages: 0, summaryChars: 0 };
    }
    if (!force) {
      if (!this.config.compaction.auto) {
        return { compacted: false, reason: "Automatic compaction is disabled.", sourceMessages: 0, summaryChars: 0 };
      }
      const ratio = contextUsageRatio(
        session,
        { ...this.config, generation: { ...this.config.generation, numCtx: this.contextLimit } },
        this.baseSystemPromptFor(session).length,
      );
      if (ratio < this.config.compaction.threshold) {
        return {
          compacted: false,
          reason: `Context usage ${(ratio * 100).toFixed(0)}% is below the ${(this.config.compaction.threshold * 100).toFixed(0)}% threshold.`,
          sourceMessages: 0,
          summaryChars: session.meta.compaction?.summary.length ?? 0,
        };
      }
    }

    const plan = planCompaction(
      session,
      this.config,
      this.compactionSourceBudget(session),
      force,
    );
    if (!plan) {
      return {
        compacted: false,
        reason: "Not enough completed older turns to compact.",
        sourceMessages: 0,
        summaryChars: session.meta.compaction?.summary.length ?? 0,
      };
    }

    this.setStatus({ state: "compacting", detail: `${plan.messages.length} messages` });
    let summary = "";
    let strategy: "model" | "fallback" = "model";

    try {
      const stream = this.provider.chat({
        model: session.meta.model,
        messages: [
          { role: "system", content: this.compactionPrompt },
          { role: "user", content: plan.source },
        ],
        signal,
        think: thinkingValue(this.modelDetailsCache.get(session.meta.model)?.thinking.modes.includes("off") ? "off" : this.currentThinking, this.modelDetailsCache.get(session.meta.model)),
        timeoutMs: Math.min(this.config.ollama.timeoutMs, 120_000),
        keepAlive: this.config.ollama.keepAlive,
        options: {
          ...this.generationOptions(),
          temperature: 0.1,
          num_predict: Math.min(
            this.config.compaction.numPredict,
            Math.max(128, Math.floor(this.contextLimit / 3)),
          ),
        },
      });
      for await (const event of stream) {
        if (event.type === "text") summary += event.text;
        else if (event.type === "error") throw event.error;
      }
      summary = normalizeSummary(summary, this.config.compaction.maxSummaryChars);
      if (summary.length < 80) throw new Error("The model returned an empty or too-short summary.");
    } catch (error) {
      if (signal.aborted) throw error;
      strategy = "fallback";
      summary = fallbackSummary(session, plan, this.config.compaction.maxSummaryChars);
      this.bus.emit("notice", {
        text: `Model compaction failed; deterministic fallback was used: ${errorMessage(error)}`,
        level: "warn",
      });
    }

    const previousCount = session.meta.compaction?.sourceMessageCount ?? 0;
    session.meta.compaction = {
      summary,
      throughMessageId: plan.throughMessageId,
      throughCreatedAt: plan.throughCreatedAt,
      sourceMessageCount: previousCount + plan.messages.length,
      updatedAt: Date.now(),
      model: session.meta.model,
      strategy,
    };
    this.liveContext = null;
    delete session.meta.lastContext;
    session.meta.updatedAt = Date.now();
    await this.store.saveMeta(session.meta);
    this.bus.emit("session.changed", { meta: session.meta });
    return {
      compacted: true,
      reason: "Session memory updated.",
      sourceMessages: plan.messages.length,
      summaryChars: summary.length,
      strategy,
    };
  }

  private async approve(request: ToolApprovalRequest, signal: AbortSignal): Promise<boolean> {
    if (this.config.tools.autoApprove) return true;
    if (signal.aborted) return false;
    const handler = this.approvalHandler;
    if (!handler) return false;

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (value: boolean): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const onAbort = (): void => finish(false);
      signal.addEventListener("abort", onAbort, { once: true });
      void handler(request).then(finish, () => finish(false));
    });
  }

  private emitTool(assistant: Message, part: ToolPart): void {
    this.bus.emit("message.updated", { messageId: assistant.id, part });
  }

  private addToolFailure(assistant: Message, error: string): void {
    const part: ToolPart = {
      type: "tool",
      callId: newToolCallId(),
      tool: "tool_call",
      input: {},
      status: "error",
      title: "Invalid tool call",
      error,
      synthetic: true,
      startedAt: Date.now(),
      endedAt: Date.now(),
    };
    assistant.parts.push(part);
    this.emitTool(assistant, part);
  }

  private approvalDetail(call: ParsedToolCall, session: Session): string {
    const lines = [`Working directory: ${session.meta.cwd}`];
    const preview: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(call.arguments)) {
      preview[key] = typeof value === "string" && value.length > 800
        ? `${value.slice(0, 800)}\n… ${value.length - 800} chars omitted`
        : value;
    }
    if (Object.keys(preview).length > 0) lines.push("", JSON.stringify(preview, null, 2));
    return lines.join("\n");
  }

  private async streamTurn(
    session: Session,
    assistant: Message,
    context: ChatMessage[],
    signal: AbortSignal,
  ): Promise<string> {
    let rawText = "";
    let textPart: TextPart | null = null;
    let reasoningPart: { type: "reasoning"; text: string } | null = null;
    let sawText = false;
    const filter = this.toolsEnabled ? new ToolCallStreamFilter() : null;
    this.liveContext = {
      input: context.reduce((sum, message) => sum + Math.ceil(message.content.length / 4) + 8, 3),
      output: 0,
      outputChars: 0,
      estimated: true,
    };

    const appendVisible = (text: string): void => {
      if (!text) return;
      if (!textPart) {
        textPart = { type: "text", text: "" };
        assistant.parts.push(textPart);
      }
      textPart.text += text;
      if (!sawText) {
        sawText = true;
        this.setStatus({ state: "responding" });
      }
      this.bus.emit("message.delta", { messageId: assistant.id, part: "text", delta: text });
    };

    const stream = this.provider.chat({
      model: session.meta.model,
      messages: context,
      signal,
      think: thinkingValue(this.currentThinking, this.modelDetailsCache.get(session.meta.model)),
      keepAlive: this.config.ollama.keepAlive,
      options: this.generationOptions(),
    });

    for await (const event of stream) {
      if ((event.type === "text" || event.type === "reasoning") && this.liveContext) {
        this.liveContext.outputChars += event.text.length;
        this.liveContext.output = Math.ceil(this.liveContext.outputChars / 4);
      }
      if (event.type === "text") {
        rawText += event.text;
        appendVisible(filter ? filter.push(event.text) : event.text);
      } else if (event.type === "reasoning") {
        if (!reasoningPart) {
          reasoningPart = { type: "reasoning", text: "" };
          assistant.parts.push(reasoningPart);
        }
        reasoningPart.text += event.text;
        if (!sawText) this.setStatus({ state: "thinking" });
        this.bus.emit("message.delta", {
          messageId: assistant.id,
          part: "reasoning",
          delta: event.text,
        });
      } else if (event.type === "done") {
        assistant.usage = mergeUsage(assistant.usage, event.usage);
        if (this.liveContext) {
          this.liveContext.input = event.usage.promptTokens;
          this.liveContext.output = event.usage.completionTokens;
          this.liveContext.estimated = false;
        }
        session.meta.lastContext = {
          inputTokens: event.usage.promptTokens,
          generatedTokens: event.usage.completionTokens,
          estimatedTokens: this.liveContext?.input ?? 0,
          at: Date.now(),
        };
        break;
      } else if (event.type === "error") {
        throw event.error;
      }
    }

    if (filter) appendVisible(filter.flush());
    return rawText;
  }

  private async executeToolCall(
    session: Session,
    assistant: Message,
    call: ParsedToolCall,
    signal: AbortSignal,
  ): Promise<boolean> {
    const tool = this.tools?.get(call.name);
    if (!tool) {
      const available = this.tools
        ?.definitions()
        .map((definition) => definition.name)
        .join(", ");
      this.addToolFailure(assistant, `Unknown tool "${call.name}". Available tools: ${available ?? "none"}.`);
      return false;
    }

    const summary = safeSummary(tool, call.arguments);

    // `say` is intentionally not rendered as a tool call: its message becomes
    // a normal assistant text part.
    if (call.name === "say") {
      try {
        const result = await tool.run(call.arguments, {
          cwd: session.meta.cwd,
          config: this.config,
          signal,
        });
        if (!result.ok) {
          this.addToolFailure(assistant, result.output);
          return false;
        }
        const message = result.userMessage?.trim() || "Done.";
        const textPart: TextPart = { type: "text", text: message };
        assistant.parts.push(textPart);
        this.bus.emit("message.delta", { messageId: assistant.id, part: "text", delta: message });
        return true;
      } catch (error) {
        if (signal.aborted) throw error;
        this.addToolFailure(assistant, errorMessage(error));
        return false;
      }
    }

    const part: ToolPart = {
      type: "tool",
      callId: newToolCallId(),
      tool: call.name,
      input: call.arguments,
      status: "pending",
      title: summary,
      startedAt: Date.now(),
    };
    assistant.parts.push(part);
    this.emitTool(assistant, part);

    let approved = tool.definition.safe || this.config.tools.autoApprove;
    if (!approved) {
      this.setStatus({ state: "tool", detail: `awaiting approval · ${call.name}` });
      approved = await this.approve(
        { tool: call.name, summary, detail: this.approvalDetail(call, session) },
        signal,
      );
    }

    if (signal.aborted) {
      part.status = "error";
      part.error = "Aborted.";
      part.endedAt = Date.now();
      this.emitTool(assistant, part);
      throw new Error("Aborted.");
    }

    if (!approved) {
      part.status = "denied";
      part.error = "Denied by the user.";
      part.endedAt = Date.now();
      this.emitTool(assistant, part);
      return false;
    }

    part.status = "running";
    part.startedAt = Date.now();
    this.emitTool(assistant, part);
    this.setStatus({ state: "tool", detail: `running ${call.name}` });

    try {
      const result = await tool.run(call.arguments, {
        cwd: session.meta.cwd,
        config: this.config,
        signal,
      });
      part.status = result.ok ? "completed" : "error";
      part.changed = result.changed ?? (result.ok && PROJECT_MUTATING_TOOLS.has(call.name) && call.name !== "execute_command");
      part.changedPaths = result.changedPaths;
      part.verification = result.ok && call.name === "execute_command" && isVerificationCommand(String(call.arguments.command ?? ""));
      part.output = result.output;
      if (!result.ok) part.error = result.output;
      part.endedAt = Date.now();
      if (part.changed) {
        this.projectInstructionCache.delete(session.meta.cwd);
      }

      if (result.userMessage?.trim()) {
        const textPart: TextPart = { type: "text", text: result.userMessage };
        assistant.parts.push(textPart);
        this.bus.emit("message.delta", {
          messageId: assistant.id,
          part: "text",
          delta: result.userMessage,
        });
      }
      return result.stop === true;
    } catch (error) {
      if (signal.aborted) {
        part.status = "error";
        part.error = "Aborted.";
        part.endedAt = Date.now();
        this.emitTool(assistant, part);
        throw error;
      }
      part.status = "error";
      part.error = errorMessage(error);
      part.endedAt = Date.now();
      return false;
    } finally {
      this.emitTool(assistant, part);
    }
  }

  private async generate(session: Session, controller = new AbortController()): Promise<void> {
    this.controller = controller;

    try {
      const compacted = controller.signal.aborted ? { compacted: false as const } : await this.performCompaction(session, false, controller.signal);
      if (compacted.compacted) {
        this.bus.emit("notice", {
          text: `Context compacted: ${compacted.sourceMessages} messages → ${compacted.summaryChars} chars (${compacted.strategy}).`,
          level: "info",
        });
      }
    } catch (error) {
      if (!controller.signal.aborted) this.bus.emit("notice", {
        text: `Automatic compaction was skipped: ${errorMessage(error)}`,
        level: "warn",
      });
    }

    const assistant: Message = {
      id: newMessageId("assistant"),
      role: "assistant",
      createdAt: Date.now(),
      model: session.meta.model,
      parts: [],
      outcome: "incomplete",
    };
    session.messages.push(assistant);
    this.bus.emit("message.started", { message: assistant });

    const toolsEnabled = this.toolsEnabled;
    const maxSteps = toolsEnabled ? Math.max(1, this.config.tools.maxIterations) : 1;
    let iteration = 0;
    let stopped = false;
    let projectVersion = 0;
    const seenCalls = new Map<string, number>();
    const request = [...session.messages].reverse().find((message) => message.role === "user");
    const required = taskRequirements(request ? textOf(request) : "");
    const requestedText = request ? textOf(request) : "";
    const needsTest = required.tests && /(?:\btests?\b|тест)/i.test(requestedText);
    const needsBuild = required.tests && /(?:\bbuild\b|сборк|собери)/i.test(requestedText);
    const checkedKinds = new Set<string>();
    let changed = false;
    let verified = false;
    let stalls = 0;
    let completionRepairs = 0;
    const unreadChangedPaths = new Set<string>();
    const volatileTools = new Set(["process_status", "list_processes", "fetch_url", "git_status", "git_diff", "git_log", "git_show"]);

    const canFinish = (candidate: string): boolean => {
      if (verified && required.tests && /(?:\bfix\b|исправ|debug)/i.test(request ? textOf(request) : "") &&
        /(?:no changes (?:needed|required|necessary)|already pass|изменения не (?:нужны|требуются)|тесты уже проходят)/i.test(candidate)) {
        assistant.outcome = "completed";
        return true;
      }
      const actualBlocker = assistant.parts.some((part) => part.type === "tool" && (part.status === "denied" || part.status === "error"));
      if (reportsBlocked(candidate) && actualBlocker) {
        assistant.outcome = "blocked";
        return true;
      }
      const reason = required.change && !changed
        ? "No workspace change has happened. A plan/promise is not completion; perform the requested change with a tool."
        : (changed || required.tests) && !verified
          ? "The latest changes have not been verified. Run the requested tests/checks (or read back changed files when no test was requested)."
          : looksLikePlan(candidate) && !verified
            ? "You returned a plan instead of performing it. Call the next tool, then report actual results."
            : "";
      if (!reason) {
        assistant.outcome = "completed";
        return true;
      }
      this.addToolFailure(assistant, `Incomplete task: ${reason}`);
      if (++completionRepairs >= this.config.tools.maxStalledSteps) {
        assistant.error = `Task stopped without verified completion: ${reason}`;
      }
      return false;
    };

    try {
      while (!stopped) {
        if (controller.signal.aborted) throw new Error("Aborted.");
        if (iteration >= maxSteps) {
          assistant.error = `Stopped after ${maxSteps} agent steps without a final answer.`;
          break;
        }
        iteration++;
        this.setStatus({ state: "connecting" });

        const systemPrompt = toolsEnabled ? this.systemPromptFor(session) : compactedMemory(session);
        const context = buildContext(
          activeMessages(session),
          this.contextBudget(systemPrompt),
          systemPrompt,
        );
        const rawText = await this.streamTurn(session, assistant, context, controller.signal);

        if (!toolsEnabled || controller.signal.aborted) {
          if (!controller.signal.aborted) assistant.outcome = "completed";
          break;
        }

        const parsed = parseToolCalls(rawText);
        if (parsed.errors.length > 0) {
          this.addToolFailure(assistant, parsed.errors.join("\n"));
          if (++stalls >= this.config.tools.maxStalledSteps) {
            assistant.error = "Stopped after repeated malformed tool calls; no verified completion.";
            break;
          }
          continue;
        }
        if (parsed.calls.length === 0) {
          if (canFinish(parsed.text)) break;
          if (assistant.error) break;
          continue;
        }

        if (parsed.calls.length > 4) {
          this.bus.emit("notice", {
            text: "The model requested more than 4 tools in one step; only the first 4 were executed.",
            level: "warn",
          });
        }

        for (const call of parsed.calls.slice(0, 4)) {
          if (controller.signal.aborted) break;
          const signature = `${call.name}:${JSON.stringify(call.arguments)}`;
          if (!volatileTools.has(call.name) && seenCalls.get(signature) === projectVersion) {
            this.addToolFailure(
              assistant,
              `Duplicate tool call blocked: ${call.name} with the same arguments already ran and project state has not changed. Use the previous observation and choose the next action.`,
            );
            if (++stalls >= this.config.tools.maxStalledSteps) assistant.error = "Stopped: repeated unchanged tool calls made no progress. Use the previous results or change the task.";
            if (assistant.error) break;
            continue;
          }
          seenCalls.set(signature, projectVersion);
          const stop = await this.executeToolCall(session, assistant, call, controller.signal);
          const completed = [...assistant.parts]
            .reverse()
            .find(
              (part): part is ToolPart =>
                part.type === "tool" && !part.synthetic && part.tool === call.name,
            );
          if (completed?.status === "completed") stalls = 0;
          else if (!stop) stalls++;
          if (completed?.status === "completed" && completed.changed) {
            projectVersion++;
            changed = true;
            verified = false;
            checkedKinds.clear();
            for (const file of completed.changedPaths ?? []) unreadChangedPaths.add(canonicalFile(session.meta.cwd, file));
          }
          if (completed?.verification) {
            for (const kind of verificationKinds(String(call.arguments.command ?? ""))) checkedKinds.add(kind);
            verified = (!needsTest || checkedKinds.has("test")) && (!needsBuild || checkedKinds.has("build"));
            if (verified) unreadChangedPaths.clear();
          } else if (completed?.status === "completed" && changed && !required.tests) {
            const readPaths = call.name === "read_file" || call.name === "file_info"
              ? [String(call.arguments.path ?? "")]
              : call.name === "read_files" && Array.isArray(call.arguments.paths) ? call.arguments.paths.map(String) : [];
            for (const file of readPaths) unreadChangedPaths.delete(canonicalFile(session.meta.cwd, file));
            if (readPaths.length && unreadChangedPaths.size === 0) verified = true;
            if (call.name === "list_dir" && completed.status === "completed") {
              const dir = canonicalFile(session.meta.cwd, String(call.arguments.path ?? "."));
              for (const file of unreadChangedPaths) if (path.dirname(file) === dir) unreadChangedPaths.delete(file);
              if (unreadChangedPaths.size === 0) verified = true;
            }
          }
          if (stop) {
            const candidate = [...assistant.parts].reverse().find((part): part is TextPart => part.type === "text")?.text ?? "";
            stopped = canFinish(candidate);
            if (stopped || assistant.error) break;
          }
          if (stalls >= this.config.tools.maxStalledSteps) assistant.error = `Stopped after ${stalls} consecutive failed/no-progress actions. Last tool: ${call.name}.`;
          if (assistant.error) break;
        }
        if (assistant.error) break;
      }
    } catch (error) {
      if (controller.signal.aborted) {
        assistant.aborted = true;
        this.setStatus({ state: "aborted" });
      } else {
        assistant.error = errorMessage(error);
        this.setStatus({ state: "error", detail: assistant.error });
      }
    } finally {
      this.controller = null;
      if (controller.signal.aborted) assistant.aborted = true;
      if (assistant.aborted || assistant.error) assistant.outcome = "incomplete";

      const hasAnswer = textOf(assistant).trim().length > 0;
      if (!assistant.error && !assistant.aborted && !hasAnswer) {
        const hasTools = assistant.parts.some((part) => part.type === "tool");
        const hasReasoning = assistant.parts.some(
          (part) => part.type === "reasoning" && part.text.trim().length > 0,
        );
        if (hasTools) {
          assistant.error = "The model stopped after tool calls without a final answer.";
        } else if (hasReasoning) {
          assistant.error =
            "The model returned thinking but no answer. Try raising generation.numPredict or using a non-thinking model.";
        } else {
          assistant.error = "The model returned an empty response.";
        }
      }

      if (assistant.error || assistant.aborted) assistant.outcome = "incomplete";
      await this.persistAssistant(session, assistant);
      this.bus.emit("message.ended", { message: assistant });
      this.setStatus({ state: "idle" });
    }
  }

  private async persistAssistant(session: Session, message: Message): Promise<void> {
    try {
      await this.store.appendMessage(session.meta.id, message);
    } catch (error) {
      this.bus.emit("notice", {
        text: `Failed to save the assistant message: ${errorMessage(error)}`,
        level: "error",
      });
    }
    session.meta.messageCount = session.messages.length;
    session.meta.updatedAt = Date.now();
    try {
      await this.store.saveMeta(session.meta);
    } catch {
      // A failed metadata write should not hide the generated answer.
    }
    this.bus.emit("session.changed", { meta: session.meta });
  }
}
