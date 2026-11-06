/** Deterministic history/compaction checks. No Ollama instance or model loading. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Bus } from "../src/core/bus.js";
import { ChatService } from "../src/core/chat.js";
import { defaultConfig, mergeConfig, type Config } from "../src/core/config/config.js";
import { activeMessages, planCompaction } from "../src/core/compaction.js";
import { buildContext, ContextOverflowError, estimateContextTokens } from "../src/core/context.js";
import type { ChatOptions, ChatStreamEvent, ModelDetails, Provider } from "../src/core/provider/types.js";
import { SessionStore } from "../src/core/session/store.js";
import { sessionToMarkdown } from "../src/core/session/export.js";
import type { Message, SessionMeta } from "../src/core/session/types.js";
import { ToolRegistry } from "../src/tools/registry.js";

const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Temp", "opencode") : os.tmpdir();
await mkdir(base, { recursive: true });
const root = await mkdtemp(path.join(base, "tinycode-history-"));
const COMPACT_PROMPT = "HISTORY COMPACTION TEST";
const toolCall = (step: number): string => `<tool_call>${JSON.stringify({ name: "read_file", arguments: { path: `step-${step}` } })}</tool_call>`;
const observation = (step: number, size = 1_800): string =>
  `FACT-STEP-${step}-BEGIN\n${"x".repeat(Math.floor(size / 2))}\nFACT-STEP-${step}-MIDDLE\n${"y".repeat(Math.floor(size / 2))}\nFACT-STEP-${step}-END`;

class HistoryProvider implements Provider {
  id = "history";
  name = "History replay";
  normal: ChatOptions[] = [];
  summaries: ChatOptions[] = [];
  beforeNormal?: (request: ChatOptions, index: number) => Promise<void> | void;
  beforeSummary?: (request: ChatOptions) => Promise<void> | void;
  failSummary = false;

  constructor(private readonly turns: string[]) {}
  async listModels() { return [{ id: "history:8b", name: "history:8b" }]; }
  async health() { return { ok: true }; }
  async getModelDetails(model: string): Promise<ModelDetails> {
    return { id: model, name: model, contextLength: 131_072, thinking: { modes: ["off"], defaultMode: "off", control: "none" } };
  }
  async *chat(options: ChatOptions): AsyncIterable<ChatStreamEvent> {
    const request = { ...options, messages: options.messages.map((message) => ({ ...message })), options: { ...options.options } };
    assert(estimateContextTokens(request.messages) + Number(request.options.num_predict) <= Number(request.options.num_ctx), "no oversized request may reach the provider");
    if (request.messages[0]?.content === COMPACT_PROMPT) {
      this.summaries.push(request);
      await this.beforeSummary?.(request);
      if (request.signal?.aborted) throw new Error("Summary aborted.");
      if (this.failSummary) throw new Error("Fake summarizer is unavailable.");
      const facts = [...new Set(request.messages[1]!.content.match(/FACT-STEP-\d+/g) ?? [])];
      yield { type: "text", text: `## Goal\n- Keep inspecting the requested files.\n\n## Verified observations\n- ${facts.join(", ") || "Older conversation facts"}\n\n## Next step\n- Continue from the latest intact tool result; do not invent completed work.` };
    } else {
      const index = this.normal.length;
      this.normal.push(request);
      await this.beforeNormal?.(request, index);
      yield { type: "text", text: this.turns[Math.min(index, this.turns.length - 1)]! };
    }
    const promptTokens = estimateContextTokens(request.messages);
    yield { type: "done", usage: { promptTokens, completionTokens: 12, totalTokens: promptTokens + 12 } };
  }
}

async function fixture(name: string, turns: string[], numCtx = 4096, outputSize = 1800, store?: SessionStore) {
  const cwd = path.join(root, name);
  await mkdir(cwd, { recursive: true });
  const config = defaultConfig();
  config.model = "history:8b";
  config.generation.numCtx = numCtx;
  config.generation.numPredict = 256;
  const provider = new HistoryProvider(turns);
  const tools = new ToolRegistry().register({
    definition: {
      name: "read_file", description: "Read a test file.", safe: true, summary: (input) => String(input.path),
      parameters: { type: "object", properties: { path: { type: "string", description: "File path." } }, required: ["path"] },
    },
    async run(input) {
      const step = Number(String(input.path).split("-").at(-1));
      return { ok: true, output: observation(step, outputSize), readPaths: [path.join(cwd, String(input.path))] };
    },
  });
  const actualStore = store ?? new SessionStore(path.join(root, `${name}-sessions`));
  const bus = new Bus();
  const notices: string[] = [];
  bus.on("notice", ({ text }) => notices.push(text));
  const chat = new ChatService({ config, provider, tools, store: actualStore, bus, cwd, systemPrompt: "Test agent", compactionPrompt: COMPACT_PROMPT });
  await chat.initialize({ model: config.model, cwd });
  return { chat, config, provider, tools, store: actualStore, cwd, notices };
}

try {
  assert.equal(defaultConfig().context.maxMessages, 0);
  assert.equal(defaultConfig().context.maxChars, 0);
  const legacy = mergeConfig({ context: { maxMessages: 24, maxChars: 24_000 } });
  assert.equal(legacy.context.maxChars, 24_000, "legacy config is retained, not silently rewritten");
  const full = await fixture("full-history", ["All previous messages are available."], 65_536);
  full.config.context = legacy.context;
  const original: Message[] = Array.from({ length: 40 }, (_, index) => ({
    id: `history-${index}`, role: index % 2 === 0 ? "user" : "assistant", createdAt: index + 1,
    parts: [{ type: "text", text: `CHAT-${index}-BEGIN ${"detail ".repeat(150)} CHAT-${index}-END` }], outcome: "completed",
  }));
  full.chat.current!.messages.push(...original);
  await full.store.rewriteMessages(full.chat.current!.meta.id, full.chat.current!.messages);
  await full.chat.send("Explain the full conversation.");
  assert.equal(full.provider.summaries.length, 0);
  const input = full.provider.normal[0]!.messages.map((message) => message.content).join("\n");
  assert(input.length > 24_000);
  let previous = -1;
  for (const message of original) {
    const text = message.parts[0]!;
    assert(text.type === "text");
    const at = input.indexOf(text.text);
    assert(at > previous, `${message.id} must be included completely and in order`);
    previous = at;
  }
  assert.equal(full.chat.current!.messages.at(-1)!.outcome, "completed");
  assert(!input.includes("context entry truncated") && !input.includes("chars omitted"));
  full.tools.dispose();
  console.log("ok full history beyond 24 messages / 24k characters / legacy configs");

  const steps = 10;
  const loop = await fixture("tool-loop", [...Array.from({ length: steps }, (_, index) => toolCall(index + 1)), "Finished inspecting all files."]);
  const prompt = "Inspect every file in order and remember all observations.";
  let persistedCheckpointSeen = false;
  let lastSeenCheckpoint = 0;
  loop.provider.beforeNormal = async (request, index) => {
    const text = request.messages.map((message) => message.content).join("\n");
    assert(text.includes(prompt), "the exact current user request must survive a tool checkpoint");
    if (!text.includes("<session_memory>")) {
      for (let step = 1; step <= index; step++) assert(text.includes(observation(step)), `step ${step} must not be shortened before compaction`);
    } else {
      assert(text.includes(observation(index)), "the newest tool observation remains complete");
      const saved = await loop.store.load(loop.chat.current!.meta.id);
      assert(saved.meta.compaction?.throughPartCount);
      assert.equal(new Set(saved.messages.map((message) => message.id)).size, saved.messages.length);
      assert(saved.meta.compaction.throughPartCount <= saved.messages.at(-1)!.parts.length, "the cursor only covers durable raw parts");
      if (loop.provider.summaries.length > lastSeenCheckpoint) {
        assert(saved.messages.at(-1)!.parts.some((part) => part.type === "tool" && part.output === observation(index)), "the checkpoint includes its latest raw result");
        lastSeenCheckpoint = loop.provider.summaries.length;
      }
      persistedCheckpointSeen = true;
    }
  };
  await loop.chat.send(prompt);
  assert.equal(loop.provider.normal.length, steps + 1, loop.chat.current!.messages.at(-1)!.error);
  assert(loop.provider.summaries.length >= 1, "compaction must run inside one user turn");
  assert(persistedCheckpointSeen);
  assert.equal(loop.chat.current!.messages.at(-1)!.outcome, "completed");
  const stored = await loop.store.load(loop.chat.current!.meta.id);
  assert.equal(stored.messages.length, 2, "checkpointing must not append duplicate assistant snapshots");
  const recorded = stored.messages.at(-1)!.parts.filter((part) => part.type === "tool");
  assert.equal(recorded.length, steps);
  for (let step = 1; step <= steps; step++) assert.equal(recorded[step - 1]!.output, observation(step));
  const exported = sessionToMarkdown(stored);
  for (let step = 1; step <= steps; step++) assert(exported.includes(observation(step)));
  assert(stored.meta.compaction!.throughPartCount! < stored.messages.at(-1)!.parts.length);
  assert(activeMessages(stored)[0]!.id === stored.messages[0]!.id);

  const resumedProvider = new HistoryProvider(["Continued from the checkpoint."]);
  const resumed = new ChatService({ config: loop.config, provider: resumedProvider, tools: loop.tools, store: loop.store, bus: new Bus(), cwd: loop.cwd, systemPrompt: "Test agent", compactionPrompt: COMPACT_PROMPT });
  await resumed.resume(stored.meta.id);
  await resumed.send("Continue from the saved state.");
  const resumedInput = resumedProvider.normal[0]!.messages.map((message) => message.content).join("\n");
  assert(resumedInput.includes("<session_memory>") && resumedInput.includes(observation(steps)));
  assert(resumedInput.includes(prompt));
  assert(!resumedInput.includes(observation(1)), "already summarized results must not be replayed as raw observations");
  loop.tools.dispose();
  console.log("ok in-turn compaction / intact latest observation / durable raw history / resume and export");

  const emergency = await fixture("emergency", [toolCall(1), "Finished inspecting the file."], 4096, 14_000);
  emergency.config.generation.numPredict = 2048;
  emergency.config.compaction.numPredict = 256;
  await emergency.chat.send("Inspect the file.");
  assert.equal(emergency.provider.normal.length, 2);
  assert.equal(emergency.provider.summaries.length, 1);
  assert.equal(emergency.chat.current!.messages.at(-1)!.outcome, "completed");
  assert(emergency.provider.summaries[0]!.messages[1]!.content.includes(observation(1, 14_000)), "emergency compaction must receive the full latest result, not head+tail");
  assert(emergency.provider.normal[1]!.messages[0]!.content.includes("<session_memory>"));
  assert.equal((await emergency.store.load(emergency.chat.current!.meta.id)).messages.at(-1)!.parts.find((part) => part.type === "tool")?.output, observation(1, 14_000));
  emergency.tools.dispose();
  console.log("ok oversized latest result is summarized explicitly when the full source fits");

  for (const enabled of [false, true]) {
    const huge = await fixture(`huge-${enabled}`, [toolCall(1), "Must not be generated."], 1024, 7000);
    huge.config.compaction.auto = enabled;
    await huge.chat.send("Inspect the file.");
    assert.equal(huge.provider.normal.length, 1);
    assert.equal(huge.provider.summaries.length, 0);
    const assistant = huge.chat.current!.messages.at(-1)!;
    assert.match(assistant.error!, /No messages were discarded/);
    assert.equal(assistant.outcome, "incomplete");
    assert.equal(assistant.parts.find((part) => part.type === "tool")?.output, observation(1, 7000));
    assert(huge.chat.contextPressure > 1);
    assert.doesNotThrow(() => huge.chat.contextUsage);
    const saved = await huge.store.load(huge.chat.current!.meta.id);
    assert.equal(saved.messages.at(-1)!.parts.find((part) => part.type === "tool")?.output, observation(1, 7000));
    huge.tools.dispose();
  }
  const oversizedPrompt = await fixture("huge-prompt", ["Must not be generated."], 1024);
  await oversizedPrompt.chat.send("Ж".repeat(3000));
  assert.equal(oversizedPrompt.provider.normal.length, 0);
  assert.match(oversizedPrompt.chat.current!.messages.at(-1)!.error!, /No messages were discarded/);
  oversizedPrompt.tools.dispose();
  assert.throws(() => buildContext(original, { maxMessages: 0, maxChars: 0, maxTokens: 100 }), ContextOverflowError);
  console.log("ok explicit overflow refusal / UTF-8 budget / no model calls with omitted history");

  const failedSummary = await fixture("fallback", [...Array.from({ length: steps }, (_, index) => toolCall(index + 1)), "Finished inspecting all files."]);
  failedSummary.provider.failSummary = true;
  await failedSummary.chat.send(prompt);
  assert.equal(failedSummary.chat.current!.meta.compaction?.strategy, "fallback");
  assert(failedSummary.notices.some((notice) => notice.includes("deterministic fallback")));
  assert.equal((await failedSummary.store.load(failedSummary.chat.current!.meta.id)).messages.at(-1)!.parts.filter((part) => part.type === "tool").length, steps);
  failedSummary.tools.dispose();

  const cancelled = await fixture("cancelled", [...Array.from({ length: steps }, (_, index) => toolCall(index + 1)), "Must not finish."]);
  cancelled.provider.beforeSummary = () => cancelled.chat.abort();
  await cancelled.chat.send(prompt);
  assert.equal(cancelled.provider.summaries.length, 1);
  assert.equal(cancelled.chat.current!.meta.compaction, undefined);
  assert.equal(cancelled.chat.current!.messages.at(-1)!.aborted, true);
  const cancelledSaved = await cancelled.store.load(cancelled.chat.current!.meta.id);
  assert.equal(cancelledSaved.messages.at(-1)!.parts.filter((part) => part.type === "tool").length, cancelled.provider.normal.length);
  cancelled.tools.dispose();
  console.log("ok failed summarizer fallback / cancelled summary preserves original work");

  class RefuseCompactionMeta extends SessionStore {
    override async saveMeta(meta: SessionMeta): Promise<void> {
      if (meta.compaction) throw new Error("Fake checkpoint metadata failure.");
      await super.saveMeta(meta);
    }
  }
  const badStore = new RefuseCompactionMeta(path.join(root, "bad-meta-sessions"));
  const failedMeta = await fixture("bad-meta", [...Array.from({ length: steps }, (_, index) => toolCall(index + 1)), "Must not finish with missing history."], 4096, 1800, badStore);
  await failedMeta.chat.send(prompt);
  assert(failedMeta.notices.some((notice) => notice.includes("checkpoint metadata failure")));
  assert.equal(failedMeta.chat.current!.meta.compaction, undefined);
  const failedSaved = await badStore.load(failedMeta.chat.current!.meta.id);
  assert.equal(failedSaved.meta.compaction, undefined);
  assert.equal(new Set(failedSaved.messages.map((message) => message.id)).size, failedSaved.messages.length);
  assert.equal(failedSaved.messages.at(-1)!.parts.filter((part) => part.type === "tool").length, failedMeta.provider.normal.length);
  assert.match(failedSaved.messages.at(-1)!.error!, /No messages were discarded/);
  failedMeta.tools.dispose();

  const tinyPlan = planCompaction(stored, loop.config, 20, true, true);
  assert.equal(tinyPlan, null, "a source that does not fit must not be truncated and marked compacted");
  const jsonl = await readFile(path.join(root, "tool-loop-sessions", stored.meta.id, "messages.jsonl"), "utf8");
  assert(jsonl.includes("FACT-STEP-1-MIDDLE"));
  console.log("ok checkpoint persistence failure / no cursor advancement over unread source");
  console.log("all history checks passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
