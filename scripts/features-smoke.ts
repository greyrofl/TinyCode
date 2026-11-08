import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { ChildProcess } from "node:child_process";
import { Bus } from "../src/core/bus.js";
import { ChatService, claimsChecksPassed } from "../src/core/chat.js";
import { defaultConfig, mergeConfig } from "../src/core/config/config.js";
import { OllamaRuntime, isLocalOllamaUrl } from "../src/core/ollama-runtime.js";
import { defaultToolProfile, modelParameterBillions, resolveToolProfile } from "../src/core/tool-profile.js";
import { calculateContextCapacity, contextCapacityMessage, contextChoices } from "../src/core/context-memory.js";
import { OllamaProvider } from "../src/core/provider/ollama.js";
import { parseModelDetails } from "../src/core/provider/model-details.js";
import type { ChatOptions, ChatStreamEvent, ModelDetails, Provider, RunningModelInfo } from "../src/core/provider/types.js";
import { SessionStore } from "../src/core/session/store.js";
import { createDefaultTools } from "../src/tools/registry.js";
import { toolBlock, toolRepairHint } from "../src/core/prompt/system.js";
import { parseToolCalls } from "../src/tools/parse.js";
import { TinyCodeTui } from "../src/tui/app.js";
import { Picker, renderPicker } from "../src/tui/picker.js";
import { getPalette } from "../src/tui/theme.js";
import { taskRequirements } from "../src/core/task-guard.js";
import { isVerificationCommand, verificationKinds } from "../src/tools/change-feedback.js";
import { buildContext } from "../src/core/context.js";
import { attachMcpTools } from "../src/mcp/manager.js";
import { parseDuckDuckGo } from "../src/tools/web-search-tool.js";
import { OpenAICompatibleProvider } from "../src/core/provider/openai-compatible.js";
import { recommendModels } from "../src/core/model-recommendations.js";

const base = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, "Temp", "opencode") : os.tmpdir();
await mkdir(base, { recursive: true });
const root = await mkdtemp(path.join(base, "tinycode-features-"));
const previousHome = process.env.TINYCODE_HOME;
process.env.TINYCODE_HOME = path.join(root, "home");

class Replay implements Provider {
  id = "replay";
  name = "Replay";
  requests: ChatOptions[] = [];
  loads: Array<{ model: string; numCtx: number }> = [];
  unloads: string[] = [];
  running: RunningModelInfo | null = null;
  beforeChat?: (index: number) => Promise<void>;
  constructor(private readonly turns: string[]) {}
  async listModels() { return [{ id: "replay", name: "replay" }]; }
  async health() { return { ok: true }; }
  async getModelDetails(model: string): Promise<ModelDetails> {
    return {
      id: model, name: model, family: /gemma/i.test(model) ? "gemma4" : "qwen3", contextLength: 16384,
      samplingDefaults: { temperature: 0.6, topP: 0.95, topK: 20, minP: 0, repeatPenalty: 1 },
      thinking: { modes: ["off", "on"], defaultMode: "off", control: "native" },
    };
  }
  async *chat(options: ChatOptions): AsyncIterable<ChatStreamEvent> {
    this.requests.push(options);
    await this.beforeChat?.(this.requests.length - 1);
    yield { type: "text", text: this.turns[Math.min(this.requests.length - 1, this.turns.length - 1)]! };
    yield { type: "done", usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 } };
  }
  async loadModel(options: { model: string; numCtx: number }) {
    if (this.running?.id === options.model && this.running.contextLength === options.numCtx) return this.running;
    this.loads.push({ model: options.model, numCtx: options.numCtx });
    this.running = { id: options.model, sizeBytes: 6_000_000_000, sizeVramBytes: 4_000_000_000, contextLength: options.numCtx };
    return this.running;
  }
  async getRunningModel(model: string) {
    return this.running?.id === model ? this.running : null;
  }
  async unloadModel(model: string) {
    const previous = await this.getRunningModel(model);
    this.unloads.push(model);
    this.running = null;
    return previous;
  }
}
const call = (name: string, arguments_: Record<string, unknown>) =>
  `<tool_call>${JSON.stringify({ name, arguments: arguments_ })}</tool_call>`;

async function fixture(name: string, turns: string[]) {
  const cwd = path.join(root, name);
  await mkdir(path.join(cwd, "src"), { recursive: true });
  await mkdir(path.join(cwd, "test"), { recursive: true });
  await writeFile(path.join(cwd, "src/main.mjs"), "export const answer = 41;\n");
  await writeFile(path.join(cwd, "package.json"), '{"type":"module","scripts":{"test":"node --test"}}');
  await writeFile(path.join(cwd, "test/main.test.mjs"), 'import assert from "node:assert/strict"; import {answer} from "../src/main.mjs"; assert.equal(answer,42);');
  const config = defaultConfig();
  config.generation.numPredict = 512;
  config.models.replay = { thinking: "off", numCtx: 4096 };
  const provider = new Replay(turns);
  const tools = createDefaultTools();
  const store = new SessionStore(path.join(root, `${name}-sessions`));
  const chat = new ChatService({ config, provider, store, tools, bus: new Bus(), cwd, systemPrompt: "Test agent" });
  chat.setApprovalHandler(async () => true);
  await chat.initialize({ model: "replay", cwd });
  return { chat, config, provider, tools, cwd, store };
}

try {
  assert.equal(claimsChecksPassed("Я не утверждаю, что проверка прошла успешно, если verify не выдал подтверждения."), false);
  assert.equal(claimsChecksPassed("Tests did not pass; they were not run."), false);
  assert.equal(claimsChecksPassed("Проверка прошла успешно: 12 тестов пройдены."), true);
  assert.equal(claimsChecksPassed("Typecheck passed successfully."), true);
  const searchResults = parseDuckDuckGo(`
    <div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs">Example &amp; Docs</a>
    <a class="result__snippet">Trusted-looking &lt;text&gt; is still untrusted.</a></div>
  `, 5);
  assert.deepEqual(searchResults, [{ title: "Example & Docs", url: "https://example.com/docs", snippet: "Trusted-looking <text> is still untrusted." }]);
  const recommendations = recommendModels({ ram: { totalBytes: 32 * 1024 ** 3, freeBytes: 20 * 1024 ** 3 }, gpus: [{ id: "gpu", name: "8GB", totalBytes: 8 * 1024 ** 3, freeBytes: 6 * 1024 ** 3 }], source: "test" });
  assert.equal(recommendations.find((model) => model.id === "qwen3-8b-q4")?.placement, "hybrid");
  assert.equal(recommendations.find((model) => model.id === "gemma-4-26b-a4b-ud-q4")?.placement, "hybrid");
  assert(recommendations.some((model) => model.id === "qwen3-coder-30b-a3b-q4"));
  assert(recommendations.every((model) => model.totalParametersB >= 8));
  assert(recommendations.every((model) => model.recommendedContext >= 32768 && model.installCommand.startsWith("ollama pull ")));
  const vramRecommendations = recommendModels({ ram: { totalBytes: 64 * 1024 ** 3, freeBytes: 50 * 1024 ** 3 }, gpus: [{ id: "gpu24", name: "24GB", totalBytes: 24 * 1024 ** 3, freeBytes: 20 * 1024 ** 3 }], source: "test" });
  assert.equal(vramRecommendations.find((model) => model.id === "gemma-4-26b-a4b-ud-q4")?.placement, "vram");
  const ramRecommendations = recommendModels({ ram: { totalBytes: 64 * 1024 ** 3, freeBytes: 50 * 1024 ** 3 }, gpus: [], source: "test" });
  assert(ramRecommendations.length > 0 && ramRecommendations.every((model) => model.placement === "ram"));
  const externalConfig = mergeConfig({
    provider: "lab",
    providers: {
      lab: {
        type: "openai-compatible",
        name: "Local Lab",
        baseUrl: "http://127.0.0.1:9000/v1",
        models: {
          coder: {
            name: "Coder",
            contextLength: 32768,
            parameterSize: "14B",
            thinking: { modes: ["off", "high"], defaultMode: "off", field: "reasoning_effort", values: { off: "none", high: "high" } },
          },
        },
      },
    },
  });
  assert.equal(externalConfig.provider, "lab"); assert.equal(externalConfig.model, "coder");
  const externalRequests: Record<string, unknown>[] = [];
  const externalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (url, init) => {
      if (String(url).endsWith("/models")) return new Response('{"data":[]}');
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>; externalRequests.push(body);
      const stream = [
        { choices: [{ delta: { reasoning_content: "Check." }, finish_reason: null }] },
        { choices: [{ delta: { content: "Answer." }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
      ].map((item) => `data: ${JSON.stringify(item)}\n\n`).join("") + "data: [DONE]\n\n";
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const external = new OpenAICompatibleProvider("lab", externalConfig.providers.lab!);
    assert.equal((await external.getModelDetails("coder")).contextLength, 32768);
    const events: ChatStreamEvent[] = [];
    for await (const event of external.chat({ model: "coder", messages: [{ role: "user", content: "Hi" }], think: "high", options: { num_ctx: 32768, num_predict: 100, temperature: .2 } })) events.push(event);
    assert(events.some((event) => event.type === "reasoning")); assert(events.some((event) => event.type === "text" && event.text === "Answer."));
    assert.equal(externalRequests[0]!.max_tokens, 100); assert.equal(externalRequests[0]!.reasoning_effort, "high"); assert(!("num_ctx" in externalRequests[0]!));
  } finally { globalThis.fetch = externalFetch; }
  assert.equal(taskRequirements("Explain the failing test; do not change files.").change, false);
  assert.equal(taskRequirements("How to fix failing tests?").change, false);
  assert.equal(taskRequirements("Explain the error and fix it.").change, true);
  assert.deepEqual(taskRequirements("Исправь код и запусти тесты."), { change: true, tests: true });
  assert.equal(isVerificationCommand("npm test || echo passed"), false);
  assert.equal(isVerificationCommand("npm test | cat"), false);
  assert.equal(isVerificationCommand('cd "D:\\workspace" && node --experimental-strip-types --test test/catalog.test.ts'), true);
  assert.equal(verificationKinds('cd "D:\\workspace" && node --experimental-strip-types --test test/catalog.test.ts').has("test"), true);
  assert.equal(isVerificationCommand("node --experimental-strip-types --test test/catalog.test.ts || echo passed"), false);
  assert.equal(isVerificationCommand('node --eval "console.log(\'passed\')" --test'), false);
  const olderOutput = `HEAD-${"a".repeat(7000)}-TAIL`;
  const latestOutput = `LATEST-${"b".repeat(8000)}-END`;
  const observationContext = buildContext([
    { id: "obs-u", role: "user", createdAt: 1, parts: [{ type: "text", text: "inspect" }] },
    { id: "obs-a", role: "assistant", createdAt: 2, parts: [
      { type: "tool", callId: "old", tool: "read_file", input: { path: "a" }, status: "completed", output: olderOutput },
      { type: "tool", callId: "new", tool: "execute_command", input: { command: "test" }, status: "error", error: latestOutput },
    ] },
  ], { maxMessages: 10, maxChars: 30_000 });
  const observations = observationContext.filter((message) => message.role === "user").map((message) => message.content);
  assert(observations.some((value) => value.includes(olderOutput)));
  assert(observations.every((value) => !value.includes("chars omitted")));
  assert(observations.some((value) => value.includes(latestOutput)));

  const plan = await fixture("plan", ["I will fix the file."]);
  await plan.chat.send("Fix the code");
  assert.equal(plan.chat.current!.messages.at(-1)!.outcome, "incomplete");
  assert.match(plan.chat.current!.messages.at(-1)!.error!, /without verified completion/);
  assert.equal(await readFile(path.join(plan.cwd, "src/main.mjs"), "utf8"), "export const answer = 41;\n");
  plan.tools.dispose();

  const profiles = createDefaultTools();
  assert.equal(defaultConfig().tools.autoApprove, false);
  assert.equal(defaultConfig().tools.profile, "auto");
  assert.deepEqual(profiles.definitions().filter((tool) => !tool.safe).map((tool) => tool.name).sort(),
    ["execute_command", "start_process", "verify"]);
  assert.equal(profiles.definitionsFor("auto", "plan").some((tool) => tool.name === "edit_file"), false);
  assert.equal(profiles.definitionsFor("auto", "plan").some((tool) => tool.name === "verify"), true);
  assert.equal(profiles.definitions("plan").some((tool) => tool.name === "verify"), false);
  assert.equal(profiles.definitionsFor("auto", "edit").some((tool) => tool.name === "edit_file"), true);
  assert.equal(profiles.definitionsFor("auto", "edit").some((tool) => tool.name === "execute_command"), false);
  assert.equal(profiles.definitionsFor("auto", "full").some((tool) => tool.name === "execute_command"), true);
  for (const stage of ["plan", "edit", "verify"] as const) {
    for (const name of ["execute_command", "start_process", "stop_process"]) {
      assert.equal(profiles.isAllowedFor("auto", stage, name), false);
    }
    assert.equal(profiles.isAllowedFor("auto", stage, "fetch_url"), true);
    assert.equal(profiles.isAllowedFor("auto", stage, "web_search"), true);
  }
  const approvalCatalog = toolBlock(profiles.definitions());
  for (const name of ["edit_file", "replace_file", "apply_patch", "delete_file", "fetch_url", "stop_process"]) {
    assert(approvalCatalog.includes(`### ${name} [automatic]`));
  }
  for (const name of ["execute_command", "start_process", "verify"]) {
    assert(approvalCatalog.includes(`### ${name} [user approval required]`));
  }
  const signature = toolRepairHint(profiles.definition("search_text")!, '{"name":"search_text","arguments":{', "Invalid JSON");
  assert.match(signature, /query:string!/);
  assert.match(signature, /regex:boolean\?/);
  assert.match(signature, /literal/);
  assert.match(signature, /Valid example/);
  assert.equal(parseToolCalls('<tool_call>{"name":"search_text","arguments":{</tool_call>').issues[0]?.toolName, "search_text");
  profiles.dispose();

  const gemmaDetails = parseModelDetails("Gemma 26B A4B", {
    details: { family: "gemma4", parameter_size: "25.2B" },
    model_info: {
      "general.architecture": "gemma4", "gemma4.context_length": 262144,
      "gemma4.block_count": 30, "gemma4.attention.head_count": 16,
      "gemma4.attention.key_length": 512, "gemma4.attention.value_length": 512,
      "gemma4.attention.key_length_swa": 256, "gemma4.attention.value_length_swa": 256,
      "gemma4.attention.sliding_window": 1024,
    },
  });
  assert.equal(gemmaDetails.contextMemory?.variableKvBytesPerToken, 20_480);
  assert.equal(gemmaDetails.contextMemory?.fixedKvBytes, 209_715_200);
  const capacity = calculateContextCapacity({
    details: gemmaDetails,
    running: { id: gemmaDetails.id, sizeBytes: 18_711_041_801, sizeVramBytes: 5_250_524_119, contextLength: 8192 },
    hardware: {
      ram: { totalBytes: 32 * 1024 ** 3, freeBytes: 20 * 1024 ** 3 },
      gpus: [{ id: "gpu", name: "test", totalBytes: 8 * 1024 ** 3, freeBytes: 300 * 1024 ** 2 }],
      source: "test",
    },
    parallel: 1, requestedContext: 8192,
  });
  assert.equal(capacity.maximum, 262144);
  assert.equal(capacity.exact, true);
  assert.equal(capacity.placement, "mixed");
  assert.equal(capacity.vramMaximum, 0);
  assert.match(contextCapacityMessage(capacity), /Max context: 262,144.*exact model limit.*RAM ctx/);
  assert(contextChoices(262144, 8192, capacity.maximum, 4096).includes(262144));
  const cpuCapacity = calculateContextCapacity({
    details: gemmaDetails,
    running: { id: gemmaDetails.id, sizeBytes: 18_000_000_000, sizeVramBytes: 0, contextLength: 32_768 },
    hardware: { ram: { totalBytes: 64 * 1024 ** 3, freeBytes: 32 * 1024 ** 3 }, gpus: [], source: "test" },
    parallel: 4, requestedContext: 8192, forceCpu: true,
  });
  assert.equal(cpuCapacity.loadedContext, 8192);
  assert.equal(cpuCapacity.placement, "ram");
  assert.equal(cpuCapacity.vramMaximum, 0);
  assert(Number.isFinite(cpuCapacity.maximum) && cpuCapacity.maximum >= 8192);
  const unknownCapacity = calculateContextCapacity({
    details: { ...gemmaDetails, contextMemory: undefined }, running: null, hardware: null,
    requestedContext: 4096,
  });
  assert.equal(unknownCapacity.maximum, 4096);
  assert.equal(unknownCapacity.memoryKnown, false);

  const modelNames = [
    { name: "qwen2.5-coder:7b", size: 7, profile: "auto" },
    { name: "hf.co/Qwen/Qwen3-8B-GGUF:Q4_K_M", size: 8, profile: "auto" },
    { name: "small:0.5b", size: 0.5, profile: "auto" },
    { name: "model-19.9B", size: 19.9, profile: "auto" },
    { name: "model:20b", size: 20, profile: "full" },
    { name: "Gemma 26B A4B", size: 26, profile: "full" },
    { name: "Gemma A4B 26B", size: 26, profile: "full" },
    { name: "Gemma 26 B A 4 B", size: 26, profile: "full" },
    { name: "qwen3:30b-a3b", size: 30, profile: "full" },
    { name: "hf.co/70B-owner/Gemma-26B-A4B-GGUF:Q4_K_M", size: 26, profile: "full" },
    { name: "hf.co/70B-owner/model-8b:Q6_K", size: 8, profile: "auto" },
    { name: "active-only:A32B", size: null, profile: "auto" },
    { name: "active-only A 32 B", size: null, profile: "auto" },
    { name: "model:latest", size: null, profile: "auto" },
    { name: "model-32bit-Q4_K_M", size: null, profile: "auto" },
  ];
  for (const model of modelNames) {
    assert.equal(modelParameterBillions(model.name), model.size, model.name);
    assert.equal(defaultToolProfile(model.name), model.profile, model.name);
  }
  assert.equal(resolveToolProfile(defaultConfig(), "Gemma 26B A4B"), "full");
  assert.equal(resolveToolProfile(mergeConfig({ tools: { profile: "plan" } }), "Gemma 26B A4B"), "plan");
  assert.equal(resolveToolProfile(mergeConfig({ tools: { profile: "auto", profileByModel: false } }), "Gemma 26B A4B"), "auto");

  const modelProfiles = await fixture("model-profiles", ["A direct answer."]);
  assert.equal(modelProfiles.chat.currentToolProfile, "auto");
  await modelProfiles.chat.setModel("Gemma 26B A4B");
  assert.equal(modelProfiles.chat.currentToolProfile, "full");
  assert(modelProfiles.chat.minimumContextSize > 2048);
  await assert.rejects(modelProfiles.chat.setContextSize(2048), /active tool profile needs at least/i);
  await modelProfiles.chat.send("Explain this project.");
  const largePrompt = modelProfiles.provider.requests[0]!.messages[0]!.content;
  assert.match(largePrompt, /Active profile: full/);
  assert.match(largePrompt, /### execute_command \[user approval required\]/);
  await modelProfiles.chat.setModel("qwen3:8b");
  assert.equal(modelProfiles.chat.currentToolProfile, "auto");
  await modelProfiles.chat.send("Explain this project.");
  const smallPrompt = modelProfiles.provider.requests[1]!.messages[0]!.content;
  assert.match(smallPrompt, /Active profile: auto:plan/);
  assert.doesNotMatch(smallPrompt, /### execute_command/);
  const largeSession = await modelProfiles.chat.createSession({ model: "Gemma 26B A4B" });
  await modelProfiles.chat.createSession({ model: "qwen3:8b" });
  assert.equal(modelProfiles.chat.currentToolProfile, "auto");
  await modelProfiles.chat.resume(largeSession.meta.id);
  assert.equal(modelProfiles.chat.currentToolProfile, "full");
  assert.equal(modelProfiles.config.tools.profile, "auto");
  assert.equal(modelProfiles.config.tools.profileByModel, true);

  const modelTui = new TinyCodeTui({
    chat: modelProfiles.chat, config: modelProfiles.config, persistedConfig: structuredClone(modelProfiles.config),
    bus: new Bus(), configPath: path.join(root, "home/config.json"), cwd: modelProfiles.cwd,
  });
  const profileControls = modelTui as unknown as { setToolProfile(profile: string): Promise<void>; scheduleRender(): void };
  profileControls.scheduleRender = () => {};
  await profileControls.setToolProfile("auto");
  assert.equal(modelProfiles.chat.currentToolProfile, "auto");
  const pinned = mergeConfig(JSON.parse(await readFile(path.join(root, "home/config.json"), "utf8")));
  assert.equal(pinned.tools.profileByModel, false);
  assert.equal(resolveToolProfile(pinned, "Gemma 26B A4B"), "auto");
  await modelProfiles.chat.setModel("Gemma 27B A4B");
  assert.equal(modelProfiles.chat.currentToolProfile, "auto");
  await profileControls.setToolProfile("plan");
  assert.equal(modelProfiles.chat.currentToolProfile, "plan");
  await profileControls.setToolProfile("full");
  await modelProfiles.chat.setModel("qwen3:8b");
  assert.equal(modelProfiles.chat.currentToolProfile, "full");
  await profileControls.setToolProfile("model");
  assert.equal(modelProfiles.chat.currentToolProfile, "auto");
  await modelProfiles.chat.setModel("Gemma 26B A4B");
  assert.equal(modelProfiles.chat.currentToolProfile, "full");
  const restored = mergeConfig(JSON.parse(await readFile(path.join(root, "home/config.json"), "utf8")));
  assert.equal(restored.tools.profileByModel, true);
  await assert.rejects(profileControls.setToolProfile("invalid"), /Profile must be/);
  modelProfiles.tools.dispose();

  const inferenceProfiles = await fixture("inference-profiles", ["A direct answer."]);
  inferenceProfiles.provider.id = "llama.cpp";
  await inferenceProfiles.chat.setModel("Gemma 26B A4B");
  await inferenceProfiles.chat.setInferenceProfile("mtp-3", "models/mtp-gemma.gguf");
  assert.equal(inferenceProfiles.chat.currentInferenceProfile, "mtp-3");
  assert.equal(inferenceProfiles.chat.currentInferenceDraftModel, "models/mtp-gemma.gguf");
  await inferenceProfiles.chat.setModel("qwen3:8b");
  await assert.rejects(inferenceProfiles.chat.setInferenceProfile("mtp-3", "models/mtp-qwen.gguf"), /embedded head.*Gemma sidecar/i);
  await inferenceProfiles.chat.setModel("Gemma Fresh 26B");
  const inferenceTui = new TinyCodeTui({
    chat: inferenceProfiles.chat, config: inferenceProfiles.config, persistedConfig: structuredClone(inferenceProfiles.config),
    bus: new Bus(), configPath: path.join(root, "home/config.json"), cwd: inferenceProfiles.cwd,
  });
  const inferenceUi = inferenceTui as unknown as {
    scheduleRender(): void;
    runCommand(text: string): Promise<void>;
    editor: { text: string };
  };
  inferenceUi.scheduleRender = () => {};
  await inferenceUi.runCommand("/inference mtp-3");
  assert.equal(inferenceUi.editor.text, "/inference mtp-3 ", "missing sidecar returns to path entry instead of a red profile error");
  assert.equal(inferenceProfiles.chat.currentInferenceProfile, "standard");
  inferenceProfiles.tools.dispose();
  console.log("ok model-size defaults / MoE total parameters / model switch and resume / manual profile persistence");

  const readGuard = await fixture("read-guard", [
    call("edit_file", { path: "src/main.mjs", oldText: "41", newText: "42" }),
    call("read_file", { path: "src/main.mjs" }),
    call("edit_file", { path: "src/main.mjs", oldText: "41", newText: "42" }),
    call("read_file", { path: "src/main.mjs" }),
    "Done after reading and editing the file.",
  ]);
  readGuard.config.tools.profile = "edit";
  const readGuardApprovals: string[] = [];
  readGuard.chat.setApprovalHandler(async (request) => { readGuardApprovals.push(request.tool); return false; });
  await readGuard.chat.send("Fix the code");
  const guardError = readGuard.chat.current!.messages.at(-1)!.parts.find((part) => part.type === "tool" && part.synthetic)?.error;
  assert.match(guardError!, /read_before_edit/);
  assert.equal(readGuard.chat.current!.messages.at(-1)!.outcome, "completed");
  assert.deepEqual(readGuardApprovals, []);
  readGuard.tools.dispose();

  const automaticFiles = await fixture("automatic-files", [
    call("read_file", { path: "src/main.mjs" }),
    call("edit_file", { path: "src/main.mjs", oldText: "41", newText: "42" }),
    call("replace_file", { path: "src/main.mjs", content: "export const answer = 43;\n" }),
    call("apply_patch", { patch: "--- a/src/main.mjs\n+++ b/src/main.mjs\n@@ -1 +1 @@\n-export const answer = 43;\n+export const answer = 44;\n" }),
    call("read_file", { path: "src/main.mjs" }),
    [
      call("create_file", { path: "scratch.txt", content: "scratch" }),
      call("copy_path", { source: "scratch.txt", destination: "copy.txt" }),
      call("move_path", { source: "copy.txt", destination: "moved.txt" }),
      call("delete_file", { path: "scratch.txt" }),
    ].join("\n"),
    [
      call("delete_file", { path: "moved.txt" }),
      call("make_directory", { path: "empty" }),
      call("delete_directory", { path: "empty" }),
    ].join("\n"),
    call("list_dir", { path: "." }),
    "Done. Updated the source and removed the temporary files.",
  ]);
  const fileApprovals: string[] = [];
  automaticFiles.chat.setApprovalHandler(async (request) => { fileApprovals.push(request.tool); return false; });
  await automaticFiles.chat.send("Update the source and clean up temporary files.");
  assert.equal(automaticFiles.chat.current!.messages.at(-1)!.outcome, "completed");
  assert.equal((await readFile(path.join(automaticFiles.cwd, "src/main.mjs"), "utf8")).replace(/\r\n/g, "\n"), "export const answer = 44;\n");
  for (const file of ["scratch.txt", "copy.txt", "moved.txt", "empty"]) {
    await assert.rejects(access(path.join(automaticFiles.cwd, file)), { code: "ENOENT" });
  }
  assert.deepEqual(fileApprovals, []);
  automaticFiles.tools.dispose();

  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      assert.equal(String(url), "https://docs.invalid/example");
      return new Response("Local test documentation", { headers: { "content-type": "text/plain" } });
    };
    const automaticFetch = await fixture("automatic-fetch", [
      call("fetch_url", { url: "https://docs.invalid/example" }),
      "Fetched the documentation.",
    ]);
    const fetchApprovals: string[] = [];
    automaticFetch.chat.setApprovalHandler(async (request) => { fetchApprovals.push(request.tool); return false; });
    await automaticFetch.chat.send("Fetch https://docs.invalid/example and summarize it.");
    const fetchPart = automaticFetch.chat.current!.messages.at(-1)!.parts.find((part) => part.type === "tool" && part.tool === "fetch_url");
    assert(fetchPart?.type === "tool");
    assert.equal(fetchPart.status, "completed");
    assert.match(fetchPart.output!, /Local test documentation/);
    assert.deepEqual(fetchApprovals, []);
    assert.equal(automaticFetch.config.tools.profile, "auto");
    automaticFetch.tools.dispose();
  } finally {
    globalThis.fetch = previousFetch;
  }

  const repeated = await fixture("repeat", [call("read_file", { path: "src/main.mjs" })]);
  await repeated.chat.send("Read and explain the file");
  assert.equal(repeated.provider.requests.length, 6);
  assert.match(repeated.chat.current!.messages.at(-1)!.error!, /repeated unchanged/);
  repeated.tools.dispose();

  const concurrency = await fixture("concurrent", ["4"]);
  const firstSend = concurrency.chat.send("What is 2+2?");
  await concurrency.chat.send("another request");
  await firstSend;
  assert.equal(concurrency.chat.current!.messages.length, 2);
  assert(concurrency.chat.current!.messages[1]!.parts.some((part) => part.type === "steering" && part.text === "another request"));
  assert.equal(concurrency.chat.queuedCount, 0);
  concurrency.tools.dispose();

  const queued = await fixture("queued-after-tool", [
    call("read_file", { path: "src/main.mjs" }),
    "Read the file and incorporated the queued request.",
  ]);
  let modelStarted!: () => void;
  let releaseModel!: () => void;
  const started = new Promise<void>((resolve) => { modelStarted = resolve; });
  const gate = new Promise<void>((resolve) => { releaseModel = resolve; });
  queued.provider.beforeChat = async (index) => { if (index === 0) { modelStarted(); await gate; } };
  const active = queued.chat.send("Inspect the source file.");
  await started;
  await queued.chat.send("Also explain what the exported value means.");
  assert.equal(queued.chat.queuedCount, 1);
  releaseModel();
  await active;
  assert.equal(queued.chat.queuedCount, 0);
  assert.equal(queued.provider.requests.length, 2);
  const nextContext = queued.provider.requests[1]!.messages;
  const observationIndex = nextContext.findIndex((message) => message.content.startsWith("[Observation:"));
  const steeringIndex = nextContext.findIndex((message) => message.content.includes("Also explain what the exported value means."));
  assert(observationIndex >= 0 && steeringIndex >= observationIndex, "queued steering must follow the completed tool observation");
  const queuedSaved = await queued.store.load(queued.chat.current!.meta.id);
  assert.equal(queuedSaved.meta.queuedInputs, undefined);
  assert(queuedSaved.messages.at(-1)!.parts.some((part) => part.type === "steering"));
  queued.tools.dispose();

  const goal = await fixture("goal-review", [
    "Done prematurely.",
    `The source has not been inspected.\n${call("continue_work", { message: "Read src/main.mjs, then explain the exported value using evidence." })}`,
    call("read_file", { path: "src/main.mjs" }),
    "The file exports answer = 41; this is the concrete value requested.",
    `The source was read and the answer cites its value.\n${call("work_done", { message: "The goal is complete with direct file evidence." })}`,
  ]);
  await goal.chat.setGoal("Inspect src/main.mjs and explain its exported value.");
  await goal.chat.send("Please complete the active goal.");
  const goalAssistant = goal.chat.current!.messages.at(-1)!;
  const reviews = goalAssistant.parts.filter((part) => part.type === "goal_review");
  assert.deepEqual(reviews.map((part) => part.verdict), ["continue", "work_done"]);
  assert.equal(reviews[0]!.tool, "continue_work");
  assert.equal(reviews[1]!.tool, "work_done");
  assert.equal(goal.chat.currentGoal, undefined, "work_done removes the goal for later answers");
  assert.equal(goalAssistant.outcome, "completed", goalAssistant.error);
  assert(goal.provider.requests[2]!.messages.some((message) => message.content.includes("Read src/main.mjs")), "main agent receives evaluator feedback");
  const exportedGoal = (await import("../src/core/session/export.js")).sessionToMarkdown(goal.chat.current!);
  assert.match(exportedGoal, /<summary>Goal · continue<\/summary>/);
  goal.tools.dispose();
  const cancellation = await fixture("cancel", ["Must not run"]);
  const cancelled = cancellation.chat.send("Explain the file");
  cancellation.chat.abort();
  await cancelled;
  assert.equal(cancellation.chat.current!.messages.at(-1)!.aborted, true);
  assert.equal(cancellation.provider.requests.length, 0);
  cancellation.tools.dispose();

  const commandCases = [
    { tool: "execute_command", input: { command: "node -e \"process.exit(0)\"" }, prompt: "Run this command" },
    { tool: "start_process", input: { command: "node -e \"setInterval(() => {}, 1000)\"" }, prompt: "Start a server" },
    { tool: "verify", input: { mode: "quick" }, prompt: "Run tests" },
  ];
  for (const commandCase of commandCases) {
    const denied = await fixture(`denied-${commandCase.tool}`, [
      call(commandCase.tool, commandCase.input),
      "Blocked: command permission was denied.",
    ]);
    const approvals: string[] = [];
    denied.chat.setApprovalHandler(async (request) => { approvals.push(request.tool); return false; });
    await denied.chat.send(commandCase.prompt);
    const assistant = denied.chat.current!.messages.at(-1)!;
    const deniedPart = assistant.parts.find((part) => part.type === "tool" && part.tool === commandCase.tool);
    assert(deniedPart?.type === "tool");
    assert.equal(deniedPart.status, "denied");
    assert.equal(deniedPart.output, undefined);
    assert.equal(assistant.outcome, "blocked");
    assert.deepEqual(approvals, [commandCase.tool]);
    assert.equal(await readFile(path.join(denied.cwd, "src/main.mjs"), "utf8"), "export const answer = 41;\n");
    const processes = await denied.tools.get("list_processes")!.run({}, { cwd: denied.cwd, config: denied.config, signal: new AbortController().signal });
    assert.equal(processes.output, "(no managed processes)");
    denied.tools.dispose();
  }

  const automaticCommand = await fixture("automatic-command", [
    call("execute_command", { command: "node -e \"process.stdout.write('command-ok')\"" }),
    "Command completed.",
  ]);
  automaticCommand.config.tools.autoApprove = true;
  const automaticCommandApprovals: string[] = [];
  automaticCommand.chat.setApprovalHandler(async (request) => { automaticCommandApprovals.push(request.tool); return false; });
  await automaticCommand.chat.send("Run this command");
  const commandPart = automaticCommand.chat.current!.messages.at(-1)!.parts.find((part) => part.type === "tool" && part.tool === "execute_command");
  assert(commandPart?.type === "tool");
  assert.equal(commandPart.status, "completed");
  assert.match(commandPart.output!, /command-ok/);
  assert.deepEqual(automaticCommandApprovals, []);
  automaticCommand.tools.dispose();
  console.log("ok automatic file/fetch operations / command-only approval / unchanged profile and read guards");

  const alreadyPassing = await fixture("already-pass", [
    call("verify", { mode: "quick" }),
    "All tests already pass. No changes needed.",
  ]);
  await writeFile(path.join(alreadyPassing.cwd, "src/main.mjs"), "export const answer = 42;\n");
  await alreadyPassing.chat.send("Fix the failing tests");
  assert.equal(alreadyPassing.chat.current!.messages.at(-1)!.outcome, "completed");
  alreadyPassing.tools.dispose();

  const syntaxOnly = await fixture("syntax-only", [
    call("read_file", { path: "src/main.mjs" }),
    call("edit_file", { path: "src/main.mjs", oldText: "41", newText: "42" }),
    call("diagnostics", { path: "src/main.mjs" }),
    "All tests passed.",
  ]);
  await syntaxOnly.chat.send("Fix the code and run tests");
  assert.equal(syntaxOnly.chat.current!.messages.at(-1)!.outcome, "incomplete");
  assert.match(syntaxOnly.chat.current!.messages.at(-1)!.error!, /requested tests|verification action/);
  syntaxOnly.tools.dispose();

  const success = await fixture("success", [
    call("read_file", { path: "src/main.mjs" }),
    call("edit_file", { path: "src/main.mjs", oldText: "answer = 41", newText: "answer = 42" }),
    call("verify", { mode: "quick" }),
    "Done. The code changed and npm test passed.",
  ]);
  const successApprovals: string[] = [];
  success.chat.setApprovalHandler(async (request) => { successApprovals.push(request.tool); return true; });
  await success.chat.send("Fix the code and run tests");
  assert.equal(success.chat.current!.messages.at(-1)!.outcome, "completed");
  assert.equal(success.chat.current!.messages.at(-1)!.error, undefined);
  assert.equal(success.chat.current!.messages.at(-1)!.usage?.modelRequests, 4, "assistant usage distinguishes cumulative traffic across agent requests");
  assert.deepEqual(successApprovals, ["verify"]);
  const edited = success.chat.current!.messages.at(-1)!.parts.find((part) => part.type === "tool" && part.tool === "edit_file");
  assert(edited?.type === "tool");
  assert.match(edited.output!, /Diff:.*main.mjs/);
  assert.match(edited.output!, /Current lines/);
  assert.equal(success.chat.contextUsage.tokens, 120);
  assert.equal(success.chat.contextUsage.maxTokens, 4096);
  assert.equal(success.chat.contextUsage.estimated, false);
  const systemPrompts = success.provider.requests.map((request) => request.messages[0]?.content ?? "");
  assert.match(systemPrompts[0]!, /Active profile: auto:plan/);
  assert.doesNotMatch(systemPrompts[0]!, /### edit_file/);
  assert.match(systemPrompts[1]!, /Active profile: auto:edit/);
  assert.match(systemPrompts[1]!, /### edit_file/);
  assert.match(systemPrompts[2]!, /Active profile: auto:verify/);
  assert.doesNotMatch(systemPrompts[2]!, /### execute_command/);
  assert.equal(success.provider.requests[0]!.options?.temperature, 0.7);
  assert.equal(success.provider.requests[0]!.options?.top_p, 0.8);

  const customSampling = await fixture("sampling", ["A direct answer."]);
  customSampling.config.models.replay!.sampling = { profile: "custom", temperature: 0.33, topP: 0.77, topK: 11, repeatPenalty: 1.02 };
  await customSampling.chat.send("Explain this project");
  assert.equal(customSampling.provider.requests[0]!.options?.temperature, 0.33);
  assert.equal(customSampling.provider.requests[0]!.options?.top_p, 0.77);
  assert.equal(customSampling.provider.requests[0]!.options?.top_k, 11);
  customSampling.tools.dispose();

  const stopExperiment = await fixture("stop-experiment", [call("list_dir", { path: "." }), "Done."]);
  stopExperiment.config.tools.stopAfterToolCall = true;
  await stopExperiment.chat.send("List files");
  assert((stopExperiment.provider.requests[0]!.options?.stop as string[]).includes("</tool_call>"));
  stopExperiment.tools.dispose();

  const beforeNoop = await readFile(path.join(success.cwd, "src/main.mjs"), "utf8");
  const noop = await success.tools.get("edit_file")!.run(
    { path: "src/main.mjs", oldText: "answer = 42", newText: "answer = 42" },
    { cwd: success.cwd, config: success.config, signal: new AbortController().signal },
  );
  assert.equal(noop.ok, false);
  assert.equal(noop.changed, false);
  assert.equal(await readFile(path.join(success.cwd, "src/main.mjs"), "utf8"), beforeNoop);
  const replacement = await success.tools.get("replace_file")!.run(
    { path: "src/main.mjs", content: beforeNoop },
    { cwd: success.cwd, config: success.config, signal: new AbortController().signal },
  );
  assert.equal(replacement.ok, false);
  assert.equal(replacement.changed, false);
  const command = await success.tools.get("execute_command")!.run(
    { command: "npm test" }, { cwd: success.cwd, config: success.config, signal: new AbortController().signal },
  );
  assert.equal(command.ok, true);
  assert.equal(command.changed, false);
  await writeFile(path.join(success.cwd, "src/broken.js"), "export const = ;\n");
  const badDiagnostic = await success.tools.get("diagnostics")!.run(
    { path: "src/broken.js", waitMs: 500 }, { cwd: success.cwd, config: success.config, signal: new AbortController().signal },
  );
  assert.equal(badDiagnostic.ok, false);
  assert.match(badDiagnostic.output, /SyntaxError|Unexpected token|exit code: 1/i);
  await writeFile(path.join(success.cwd, "src/broken.js"), "export const valid = 1;\n");
  const goodDiagnostic = await success.tools.get("diagnostics")!.run(
    { path: "src/broken.js", waitMs: 500 }, { cwd: success.cwd, config: success.config, signal: new AbortController().signal },
  );
  assert.equal(goodDiagnostic.ok, true);
  console.log("ok completion / repeat guard / no-op / change feedback / context counters");

  await assert.rejects(success.chat.setThinking("high"), /Unsupported/);
  await assert.rejects(success.chat.setContextSize(32768), /Model context limit/);
  await success.chat.setThinking("on");
  await success.chat.setContextSize(8192);
  const saved = await success.store.load(success.chat.current!.meta.id);
  assert.equal(saved.meta.thinking, "on");
  assert.equal(saved.meta.numCtx, 8192);
  assert.equal(success.chat.contextUsage.estimated, true);
  assert.equal(mergeConfig({ generation: { numCtx: 12288 }, models: { x: { thinking: "on" } } }).models.x!.numCtx, 12288);

  let setParallelCalls = 0;
  const runtime = {
    parallelStatus: async () => ({ value: 4, source: "test environment", local: true, canSet: true }),
    setParallelOne: async () => {
      setParallelCalls++;
      return { value: 1, source: "test", local: true, canSet: true, restartRequired: true };
    },
    memoryStatus: async () => ({
      ram: { totalBytes: 32 * 1024 ** 3, freeBytes: 20 * 1024 ** 3 },
      gpus: [{ id: "gpu", name: "test", totalBytes: 8 * 1024 ** 3, freeBytes: 1024 ** 3 }],
      source: "test",
    }),
    waitForMemoryRelease: async () => {},
  };
  const tui = new TinyCodeTui({
    chat: success.chat, config: success.config, persistedConfig: structuredClone(success.config), bus: new Bus(),
    configPath: path.join(root, "home/config.json"), cwd: success.cwd, runtime: runtime as unknown as OllamaRuntime,
  });
  const ui = tui as unknown as {
    scheduleRender(): void;
    setModel(model: string): Promise<void>;
    applyPickerSelection(kind: string, item: { value: string; label: string }): Promise<void>;
    openParallelPicker(): Promise<void>;
    preparePromptContext(signal: AbortSignal): Promise<void>;
    openContextPicker(capacity?: ReturnType<typeof calculateContextCapacity> | null, setup?: boolean): Promise<void>;
    onKey(key: { name: string; x: number; y: number }): void;
    picker: Picker;
    pickerKind: string;
    pickerHits: ReturnType<typeof renderPicker>["hits"];
  };
  ui.scheduleRender = () => {};
  assert.equal(success.provider.loads.length, 0, "opening TinyCode must not load weights");
  await success.chat.setContextSize(16384);
  const openPicker = ui.openContextPicker.bind(tui);
  let pickerReady!: () => void;
  const ready = new Promise<void>((resolve) => { pickerReady = resolve; });
  ui.openContextPicker = async (capacity, setup) => { await openPicker(capacity, setup); pickerReady(); };
  const beforeRequests = success.provider.requests.length;
  const firstMessage = success.chat.send("Hello", (signal) => ui.preparePromptContext(signal));
  await ready;
  assert.equal(success.chat.current!.messages.at(-1)!.role, "user");
  assert.equal(success.provider.requests.length, beforeRequests, "no generation before choosing context");
  assert.equal(ui.pickerKind, "context");
  assert.match(ui.picker.options.message!, /Max context:/);
  assert(ui.picker.options.items.some((item) => item.detail?.includes("RAM ctx")));
  assert.deepEqual(success.provider.loads.at(-1), { model: "replay", numCtx: 16384 });
  (ui as unknown as { picker: Picker | null; pickerKind: string | null }).picker = null;
  (ui as unknown as { picker: Picker | null; pickerKind: string | null }).pickerKind = null;
  await ui.applyPickerSelection("context", { value: "4096", label: "4,096 tokens" });
  await firstMessage;
  ui.openContextPicker = openPicker;
  assert.equal(success.provider.unloads.length, 1);
  assert.deepEqual(success.provider.loads.at(-1), { model: "replay", numCtx: 4096 });
  assert.equal(success.provider.requests.at(-1)!.options?.num_ctx, 4096);
  assert.equal(success.provider.requests.at(-1)!.options?.num_batch, 256);

  // Regression: a fresh TUI (empty runner cache) must adopt the already loaded
  // runner instead of unloading and reloading the same context.
  const loadsBeforeSame = success.provider.loads.length;
  const unloadsBeforeSame = success.provider.unloads.length;
  success.chat.clearLoadedRunner();
  await ui.openContextPicker();
  await ui.applyPickerSelection("context", { value: "4096", label: "4,096 tokens" });
  assert.equal(success.provider.loads.length, loadsBeforeSame, "same context must not reload the runner");
  assert.equal(success.provider.unloads.length, unloadsBeforeSame, "same context must not unload the runner");
  assert.equal(success.chat.loadedRunnerContext, 4096, "existing runner was adopted");

  // Out of memory at a larger saved context falls back to 8k once.
  await success.chat.setContextSize(16384);
  const originalLoadModel = success.provider.loadModel.bind(success.provider);
  success.provider.loadModel = async (options: { model: string; numCtx: number }) => {
    if (options.numCtx > 8192) {
      success.provider.loads.push({ ...options });
      throw new Error("llama-server startup failed: CUDA error: out of memory");
    }
    return originalLoadModel(options);
  };
  try {
    const loadWithFallback = (tui as unknown as {
      loadModelWithFallback(signal: AbortSignal, model: string, desired: number): Promise<{ running: RunningModelInfo; tokens: number }>;
    }).loadModelWithFallback.bind(tui);
    const fallback = await loadWithFallback(new AbortController().signal, "replay", 16384);
    assert.equal(fallback.tokens, 8192);
    assert.equal(success.chat.contextLimit, 8192);
    assert.deepEqual(success.provider.loads.at(-1), { model: "replay", numCtx: 8192 });
  } finally {
    success.provider.loadModel = originalLoadModel;
  }

  const loadsBeforeModelChange = success.provider.loads.length;
  await ui.setModel("other");
  assert.equal(ui.pickerKind, "thinking");
  await ui.applyPickerSelection("thinking", { value: "on", label: "On" });
  assert.equal(ui.pickerKind, "inference", "model setup continues from thinking to inference");
  await ui.applyPickerSelection("inference", { value: "standard", label: "Standard" });
  assert.equal(success.chat.currentInferenceProfile, "standard");
  assert.equal(success.provider.loads.length, loadsBeforeModelChange, "model picker changes metadata only");
  await ui.openContextPicker();
  assert.equal(ui.pickerKind, "context");
  await ui.applyPickerSelection("context", { value: "4096", label: "4,096 tokens" });
  assert.equal(success.chat.currentThinking, "on");
  assert.equal(success.chat.contextLimit, 4096);
  await ui.openParallelPicker();
  assert.equal(setParallelCalls, 0);
  assert.equal(ui.picker.options.items[ui.picker.index]!.value, "keep");
  ui.pickerHits = renderPicker(ui.picker, 80, 24, getPalette("dark")).hits;
  const button = ui.pickerHits.find((target) => target.index === 0)!;
  let applied = Promise.resolve();
  const apply = ui.applyPickerSelection.bind(tui);
  ui.applyPickerSelection = (kind, item) => { applied = apply(kind, item); return applied; };
  ui.onKey({ name: "click", x: button.left + 1, y: button.row });
  await applied;
  assert.equal(setParallelCalls, 1);
  assert.equal(JSON.parse(await readFile(path.join(root, "home/config.json"), "utf8")).ollama.parallel, 1);

  const firstTab = success.chat.current!.meta.id;
  await success.chat.createSession({ title: "Second workspace tab", cwd: success.cwd });
  const secondTab = success.chat.current!.meta.id;
  await success.chat.send("Keep this session in the tab bar.");
  await success.chat.createSession({ title: "Other folder", cwd: path.join(root, "other-folder") });
  const otherFolderTab = success.chat.current!.meta.id;
  await success.chat.resume(firstTab);
  const tabUi = ui as unknown as {
    refreshSessionTabs(): Promise<void>;
    buildSessionTabs(width: number): Array<{ text: string }>;
    activateSessionTab(hit: { sessionId?: string; close?: boolean }): Promise<void>;
    sessionTabs: Array<{ id: string }>;
  };
  await tabUi.refreshSessionTabs();
  assert(tabUi.sessionTabs.some((session) => session.id === firstTab));
  assert(tabUi.sessionTabs.some((session) => session.id === secondTab));
  assert(!tabUi.sessionTabs.some((session) => session.id === otherFolderTab), "tabs only include sessions from this workspace");
  assert.match(tabUi.buildSessionTabs(100).map((span) => span.text).join(""), /Second workspace tab/);
  await tabUi.activateSessionTab({ sessionId: secondTab });
  assert.equal(success.chat.current!.meta.id, secondTab);
  await tabUi.activateSessionTab({ sessionId: secondTab, close: true });
  assert.notEqual(success.chat.current!.meta.id, secondTab);
  const closedTab = await success.store.load(secondTab);
  assert.equal(closedTab.meta.id, secondTab, "closing a tab does not delete its session");
  assert.equal(typeof closedTab.meta.tabClosedAt, "number", "closed-tab state is persisted with the session");
  await tabUi.refreshSessionTabs();
  assert(!tabUi.sessionTabs.some((session) => session.id === secondTab), "a closed tab stays hidden after rebuilding startup tabs");
  await success.chat.resume(secondTab);
  await tabUi.refreshSessionTabs();
  assert.equal((await success.store.load(secondTab)).meta.tabClosedAt, undefined, "explicit resume reopens a closed tab");
  assert(tabUi.sessionTabs.some((session) => session.id === secondTab));
  success.tools.dispose();
  console.log("ok model → thinking → inference → context flow / workspace session tabs / mouse controls / preference persistence");

  const realFetch = globalThis.fetch;
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  try {
    globalThis.fetch = (async (url, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      requests.push({ url: String(url), body });
      if (String(url).endsWith("/api/show")) {
        const named = body.model === "named";
        return new Response(JSON.stringify(named ? {
          details: { family: "other" }, thinking: { values: ["low", "medium", "high"], default: "medium" },
        } : {
          details: { family: "qwen3" }, capabilities: ["thinking"], template: "{{ .System }}<think>\n",
          model_info: { "qwen3.context_length": 40960 },
        }), { headers: { "content-type": "application/json" } });
      }
      if (String(url).endsWith("/api/ps")) {
        return new Response(JSON.stringify({ models: [{ name: body.model ?? "hf-qwen", size: 5_000_000_000, size_vram: 4_000_000_000, context_length: 4096 }] }), { headers: { "content-type": "application/json" } });
      }
      if (String(url).endsWith("/api/generate") && body.prompt === "") {
        return new Response(JSON.stringify({ model: body.model, done: true, done_reason: "load", response: "" }), { headers: { "content-type": "application/json" } });
      }
      const chunk = String(url).endsWith("/api/generate")
        ? { response: "4", done: true, eval_count: 1, prompt_eval_count: 50 }
        : { message: { content: "4" }, done: true, eval_count: 1, prompt_eval_count: 50 };
      return new Response(`${JSON.stringify(chunk)}\n`);
    }) as typeof fetch;
    const provider = new OllamaProvider(defaultConfig().ollama);
    const loaded = await provider.loadModel({ model: "hf-qwen", numCtx: 4096, keepAlive: "5m" });
    assert.equal(loaded?.contextLength, 4096);
    assert.equal(requests[0]!.body.prompt, "");
    assert.equal((requests[0]!.body.options as Record<string, unknown>).num_ctx, 4096);
    const hf = await provider.getModelDetails("hf-qwen");
    assert.equal(hf.thinking.control, "prompt");
    const stream = provider.chat({ model: "hf-qwen", think: false, messages: [{ role: "user", content: "2+2?" }] });
    const events: ChatStreamEvent[] = [];
    for await (const event of stream) events.push(event);
    const raw = requests.at(-1)!;
    assert.match(raw.url, /\/api\/generate$/);
    assert.equal(raw.body.raw, true);
    assert.equal(raw.body.truncate, false);
    assert.equal(raw.body.shift, false);
    assert(String(raw.body.prompt).endsWith("<think>\n\n</think>\n\n"));
    assert.deepEqual(events.filter((event) => event.type === "text"), [{ type: "text", text: "4" }]);
    const named = await provider.getModelDetails("named");
    assert.deepEqual(named.thinking.modes, ["low", "medium", "high"]);
    for await (const _ of provider.chat({ model: "named", think: "low", messages: [{ role: "user", content: "Hi" }] })) { void _; }
    assert.equal(requests.at(-1)!.body.think, "low");
    assert.equal(requests.at(-1)!.body.truncate, false);
    assert.equal(requests.at(-1)!.body.shift, false);
    assert.equal(parseModelDetails("plain", { capabilities: ["completion"] }).thinking.control, "none");
    assert.deepEqual(parseModelDetails("unknown-thinking", { capabilities: ["thinking"] }).thinking.modes, ["auto"]);
  } finally { globalThis.fetch = realFetch; }
  console.log("ok /api/show capabilities / named levels / native think / HF hard-Off workaround");

  assert.equal(isLocalOllamaUrl("http://127.0.0.1:11434"), true);
  assert.equal(isLocalOllamaUrl("http://example.com:11434"), false);
  const previousParallel = process.env.OLLAMA_NUM_PARALLEL;
  try {
    let active = false;
    let starts = 0;
    let persists = 0;
    let memoryChecks = 0;
    let capturedEnv: NodeJS.ProcessEnv = {};
    const runtime = new OllamaRuntime({ ...defaultConfig().ollama, baseUrl: "http://127.0.0.1:11999", parallel: 4 }, {
      fetch: (async () => active ? new Response('{"version":"test"}') : Promise.reject(new Error("offline"))) as typeof fetch,
      persistParallel: async () => { persists++; },
      memoryStatus: async () => {
        memoryChecks++;
        return { ram: { totalBytes: 16_000, freeBytes: 8_000 }, gpus: [], source: "fake" };
      },
      spawnServer: (env) => {
        starts++;
        capturedEnv = env;
        active = true;
        const child = new EventEmitter() as EventEmitter & { exitCode: number | null; killed: boolean; unref(): void; kill(): boolean };
        child.exitCode = null;
        child.killed = false;
        child.unref = () => {};
        child.kill = () => { active = false; child.killed = true; child.exitCode = 0; child.emit("exit", 0); return true; };
        return child as unknown as ChildProcess;
      },
    });
    assert.equal(await runtime.ensureStarted(), true);
    assert.equal(await runtime.ensureStarted(), false);
    assert.equal(starts, 1);
    const updated = await runtime.setParallelOne();
    assert.equal(persists, 1);
    assert.equal(starts, 2);
    assert.equal(capturedEnv.OLLAMA_NUM_PARALLEL, "1");
    assert.equal(updated.restartRequired, false);
    assert.equal((await runtime.memoryStatus())?.source, "fake");
    assert.equal(memoryChecks, 1);
    const remote = new OllamaRuntime({ ...defaultConfig().ollama, baseUrl: "http://example.invalid:11434" }, {
      fetch: (async () => { throw new Error("offline"); }) as typeof fetch,
      spawnServer: () => { throw new Error("must not spawn remotely"); },
    });
    await assert.rejects(remote.ensureStarted(), /unavailable/);
    assert.equal(await remote.memoryStatus(), null);
  } finally {
    if (previousParallel === undefined) delete process.env.OLLAMA_NUM_PARALLEL;
    else process.env.OLLAMA_NUM_PARALLEL = previousParallel;
  }
  console.log("ok automatic local startup / managed restart / remote safety (no real environment writes)");

  const mcpServer = path.join(root, "fake-mcp.mjs");
  await writeFile(mcpServer, `
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") console.log(JSON.stringify({ jsonrpc:"2.0", id:msg.id, result:{ protocolVersion:"2025-06-18", capabilities:{ tools:{} }, serverInfo:{ name:"fake", version:"1" } } }));
  else if (msg.method === "tools/list") console.log(JSON.stringify({ jsonrpc:"2.0", id:msg.id, result:{ tools:[{ name:"echo", description:"Echo one value.", inputSchema:{ type:"object", properties:{ value:{ type:"string", description:"Value to echo.", enum:["hello","world"], default:"hello" } }, required:["value"] } }] } }));
  else if (msg.method === "tools/call") console.log(JSON.stringify({ jsonrpc:"2.0", id:msg.id, result:{ content:[{ type:"text", text:"echo:"+msg.params.arguments.value }] } }));
});
`, "utf8");
  const serverConfig = { enabled: true, command: process.execPath, args: [mcpServer], env: {}, cwd: process.cwd() };
  const mcpConfig = mergeConfig({ mcp: { servers: {
    fake: serverConfig,
    restricted: { ...serverConfig, safe: false },
  } } });
  assert.equal(mcpConfig.mcp.servers.fake!.safe, true);
  assert.equal(mcpConfig.mcp.servers.restricted!.safe, false);
  const mcpRegistry = createDefaultTools();
  const mcp = await attachMcpTools(mcpRegistry, mcpConfig, root);
  assert.equal(mcp.errors.length, 0);
  assert.equal(mcp.connected.length, 2);
  const mcpTool = mcpRegistry.get("mcp_fake_echo")!;
  assert.equal(mcpTool.definition.safe, true);
  assert.equal(mcpRegistry.get("mcp_restricted_echo")!.definition.safe, false);
  for (const stage of ["plan", "edit", "verify"] as const) {
    assert.equal(mcpRegistry.isAllowedFor("auto", stage, "mcp_fake_echo"), false);
  }
  assert.equal(mcpRegistry.isAllowedFor("auto", "full", "mcp_fake_echo"), true);
  assert.deepEqual(mcpTool.definition.parameters.properties.value.enum, ["hello", "world"]);
  const mcpResult = await mcpTool.run({ value: "hello" }, { cwd: root, config: mcpConfig, signal: new AbortController().signal });
  assert.equal(mcpResult.output, "echo:hello");
  mcpConfig.tools.profile = "full";
  const mcpChat = new ChatService({
    config: mcpConfig,
    provider: new Replay([
      call("mcp_fake_echo", { value: "hello" }),
      call("mcp_restricted_echo", { value: "world" }),
      "Blocked: the restricted MCP tool was denied.",
    ]),
    store: new SessionStore(path.join(root, "mcp-sessions")),
    tools: mcpRegistry, bus: new Bus(), cwd: root, systemPrompt: "Test agent",
  });
  const mcpApprovals: string[] = [];
  mcpChat.setApprovalHandler(async (request) => { mcpApprovals.push(request.tool); return false; });
  await mcpChat.initialize({ model: "replay", cwd: root });
  await mcpChat.send("Echo the two values.");
  const mcpParts = mcpChat.current!.messages.at(-1)!.parts.filter((part) => part.type === "tool");
  assert.equal(mcpParts.find((part) => part.tool === "mcp_fake_echo")?.status, "completed");
  assert.equal(mcpParts.find((part) => part.tool === "mcp_restricted_echo")?.status, "denied");
  assert.deepEqual(mcpApprovals, ["mcp_restricted_echo"]);
  mcpRegistry.dispose();
  console.log("ok MCP stdio discovery / automatic default / explicit approval restriction");
  console.log("all feature checks passed");
} finally {
  if (previousHome === undefined) delete process.env.TINYCODE_HOME;
  else process.env.TINYCODE_HOME = previousHome;
  await rm(root, { recursive: true, force: true });
}
