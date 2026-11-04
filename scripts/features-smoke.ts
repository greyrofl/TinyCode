import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { ChildProcess } from "node:child_process";
import { Bus } from "../src/core/bus.js";
import { ChatService } from "../src/core/chat.js";
import { defaultConfig, mergeConfig } from "../src/core/config/config.js";
import { OllamaRuntime, isLocalOllamaUrl } from "../src/core/ollama-runtime.js";
import { OllamaProvider } from "../src/core/provider/ollama.js";
import { parseModelDetails } from "../src/core/provider/model-details.js";
import type { ChatOptions, ChatStreamEvent, ModelDetails, Provider } from "../src/core/provider/types.js";
import { SessionStore } from "../src/core/session/store.js";
import { createDefaultTools } from "../src/tools/registry.js";
import { toolRepairHint } from "../src/core/prompt/system.js";
import { parseToolCalls } from "../src/tools/parse.js";
import { TinyCodeTui } from "../src/tui/app.js";
import { Picker, renderPicker } from "../src/tui/picker.js";
import { getPalette } from "../src/tui/theme.js";
import { taskRequirements } from "../src/core/task-guard.js";
import { isVerificationCommand } from "../src/tools/change-feedback.js";
import { buildContext } from "../src/core/context.js";
import { attachMcpTools } from "../src/mcp/manager.js";

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
  constructor(private readonly turns: string[]) {}
  async listModels() { return [{ id: "replay", name: "replay" }]; }
  async health() { return { ok: true }; }
  async getModelDetails(model: string): Promise<ModelDetails> {
    return {
      id: model, name: model, family: "qwen3", contextLength: 16384,
      samplingDefaults: { temperature: 0.6, topP: 0.95, topK: 20, minP: 0, repeatPenalty: 1 },
      thinking: { modes: ["off", "on"], defaultMode: "off", control: "native" },
    };
  }
  async *chat(options: ChatOptions): AsyncIterable<ChatStreamEvent> {
    this.requests.push(options);
    yield { type: "text", text: this.turns[Math.min(this.requests.length - 1, this.turns.length - 1)]! };
    yield { type: "done", usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 } };
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
  assert.equal(taskRequirements("Explain the failing test; do not change files.").change, false);
  assert.equal(taskRequirements("How to fix failing tests?").change, false);
  assert.equal(taskRequirements("Explain the error and fix it.").change, true);
  assert.deepEqual(taskRequirements("Исправь код и запусти тесты."), { change: true, tests: true });
  assert.equal(isVerificationCommand("npm test || echo passed"), false);
  assert.equal(isVerificationCommand("npm test | cat"), false);
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
  assert(observations.some((value) => value.includes("chars omitted") && value.includes("-TAIL")));
  assert(observations.some((value) => value.includes(latestOutput)));

  const plan = await fixture("plan", ["I will fix the file."]);
  await plan.chat.send("Fix the code");
  assert.equal(plan.chat.current!.messages.at(-1)!.outcome, "incomplete");
  assert.match(plan.chat.current!.messages.at(-1)!.error!, /without verified completion/);
  assert.equal(await readFile(path.join(plan.cwd, "src/main.mjs"), "utf8"), "export const answer = 41;\n");
  plan.tools.dispose();

  const profiles = createDefaultTools();
  assert.equal(profiles.definitionsFor("auto", "plan").some((tool) => tool.name === "edit_file"), false);
  assert.equal(profiles.definitionsFor("auto", "plan").some((tool) => tool.name === "verify"), true);
  assert.equal(profiles.definitionsFor("auto", "edit").some((tool) => tool.name === "edit_file"), true);
  assert.equal(profiles.definitionsFor("auto", "edit").some((tool) => tool.name === "execute_command"), false);
  assert.equal(profiles.definitionsFor("auto", "full").some((tool) => tool.name === "execute_command"), true);
  const signature = toolRepairHint(profiles.definition("search_text")!, '{"name":"search_text","arguments":{', "Invalid JSON");
  assert.match(signature, /query:string!/);
  assert.match(signature, /regex:boolean\?/);
  assert.match(signature, /literal/);
  assert.match(signature, /Valid example/);
  assert.equal(parseToolCalls('<tool_call>{"name":"search_text","arguments":{</tool_call>').issues[0]?.toolName, "search_text");
  profiles.dispose();

  const readGuard = await fixture("read-guard", [
    call("edit_file", { path: "src/main.mjs", oldText: "41", newText: "42" }),
    call("read_file", { path: "src/main.mjs" }),
    call("edit_file", { path: "src/main.mjs", oldText: "41", newText: "42" }),
    call("read_file", { path: "src/main.mjs" }),
    "Done after reading and editing the file.",
  ]);
  readGuard.config.tools.profile = "edit";
  await readGuard.chat.send("Fix the code");
  const guardError = readGuard.chat.current!.messages.at(-1)!.parts.find((part) => part.type === "tool" && part.synthetic)?.error;
  assert.match(guardError!, /read_before_edit/);
  assert.equal(readGuard.chat.current!.messages.at(-1)!.outcome, "completed");
  readGuard.tools.dispose();

  const repeated = await fixture("repeat", [call("read_file", { path: "src/main.mjs" })]);
  await repeated.chat.send("Read and explain the file");
  assert.equal(repeated.provider.requests.length, 4);
  assert.match(repeated.chat.current!.messages.at(-1)!.error!, /repeated unchanged/);
  repeated.tools.dispose();

  const concurrency = await fixture("concurrent", ["4"]);
  const firstSend = concurrency.chat.send("What is 2+2?");
  await assert.rejects(concurrency.chat.send("another request"), /already being generated/);
  await firstSend;
  assert.equal(concurrency.chat.current!.messages.length, 2);
  concurrency.tools.dispose();
  const cancellation = await fixture("cancel", ["Must not run"]);
  const cancelled = cancellation.chat.send("Explain the file");
  cancellation.chat.abort();
  await cancelled;
  assert.equal(cancellation.chat.current!.messages.at(-1)!.aborted, true);
  assert.equal(cancellation.provider.requests.length, 0);
  cancellation.tools.dispose();

  const denied = await fixture("denied", [
    call("read_file", { path: "src/main.mjs" }),
    call("edit_file", { path: "src/main.mjs", oldText: "41", newText: "42" }),
    "Blocked: I cannot edit without permission.",
  ]);
  denied.chat.setApprovalHandler(async () => false);
  await denied.chat.send("Fix the code");
  assert.equal(denied.chat.current!.messages.at(-1)!.outcome, "blocked");
  assert.equal(await readFile(path.join(denied.cwd, "src/main.mjs"), "utf8"), "export const answer = 41;\n");
  denied.tools.dispose();

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
  assert.match(syntaxOnly.chat.current!.messages.at(-1)!.error!, /not been verified/);
  syntaxOnly.tools.dispose();

  const success = await fixture("success", [
    call("read_file", { path: "src/main.mjs" }),
    call("edit_file", { path: "src/main.mjs", oldText: "answer = 41", newText: "answer = 42" }),
    call("verify", { mode: "quick" }),
    "Done. The code changed and npm test passed.",
  ]);
  await success.chat.send("Fix the code and run tests");
  assert.equal(success.chat.current!.messages.at(-1)!.outcome, "completed");
  assert.equal(success.chat.current!.messages.at(-1)!.error, undefined);
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
    onKey(key: { name: string; x: number; y: number }): void;
    picker: Picker;
    pickerKind: string;
    pickerHits: ReturnType<typeof renderPicker>["hits"];
  };
  ui.scheduleRender = () => {};
  await ui.setModel("other");
  assert.equal(ui.pickerKind, "thinking");
  await ui.applyPickerSelection("thinking", { value: "on", label: "On" });
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
  success.tools.dispose();
  console.log("ok model → thinking → context flow / mouse parallel button / isolated preference persistence");

  const realFetch = globalThis.fetch;
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  try {
    globalThis.fetch = (async (url, init) => {
      const body = JSON.parse(String(init?.body));
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
      const chunk = String(url).endsWith("/api/generate")
        ? { response: "4", done: true, eval_count: 1, prompt_eval_count: 50 }
        : { message: { content: "4" }, done: true, eval_count: 1, prompt_eval_count: 50 };
      return new Response(`${JSON.stringify(chunk)}\n`);
    }) as typeof fetch;
    const provider = new OllamaProvider(defaultConfig().ollama);
    const hf = await provider.getModelDetails("hf-qwen");
    assert.equal(hf.thinking.control, "prompt");
    const stream = provider.chat({ model: "hf-qwen", think: false, messages: [{ role: "user", content: "2+2?" }] });
    const events: ChatStreamEvent[] = [];
    for await (const event of stream) events.push(event);
    const raw = requests.at(-1)!;
    assert.match(raw.url, /\/api\/generate$/);
    assert.equal(raw.body.raw, true);
    assert(String(raw.body.prompt).endsWith("<think>\n\n</think>\n\n"));
    assert.deepEqual(events.filter((event) => event.type === "text"), [{ type: "text", text: "4" }]);
    const named = await provider.getModelDetails("named");
    assert.deepEqual(named.thinking.modes, ["low", "medium", "high"]);
    for await (const _ of provider.chat({ model: "named", think: "low", messages: [{ role: "user", content: "Hi" }] })) { void _; }
    assert.equal(requests.at(-1)!.body.think, "low");
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
    let capturedEnv: NodeJS.ProcessEnv = {};
    const runtime = new OllamaRuntime({ ...defaultConfig().ollama, baseUrl: "http://127.0.0.1:11999", parallel: 4 }, {
      fetch: (async () => active ? new Response('{"version":"test"}') : Promise.reject(new Error("offline"))) as typeof fetch,
      persistParallel: async () => { persists++; },
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
    const remote = new OllamaRuntime({ ...defaultConfig().ollama, baseUrl: "http://example.invalid:11434" }, {
      fetch: (async () => { throw new Error("offline"); }) as typeof fetch,
      spawnServer: () => { throw new Error("must not spawn remotely"); },
    });
    await assert.rejects(remote.ensureStarted(), /unavailable/);
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
  const mcpConfig = defaultConfig();
  mcpConfig.mcp.servers.fake = { enabled: true, command: process.execPath, args: [mcpServer], env: {}, cwd: process.cwd(), safe: true };
  const mcpRegistry = createDefaultTools();
  const mcp = await attachMcpTools(mcpRegistry, mcpConfig, root);
  assert.equal(mcp.errors.length, 0);
  assert.equal(mcp.connected.length, 1);
  const mcpTool = mcpRegistry.get("mcp_fake_echo")!;
  assert.deepEqual(mcpTool.definition.parameters.properties.value.enum, ["hello", "world"]);
  const mcpResult = await mcpTool.run({ value: "hello" }, { cwd: root, config: mcpConfig, signal: new AbortController().signal });
  assert.equal(mcpResult.output, "echo:hello");
  mcpRegistry.dispose();
  console.log("ok MCP stdio discovery and tool call");
  console.log("all feature checks passed");
} finally {
  if (previousHome === undefined) delete process.env.TINYCODE_HOME;
  else process.env.TINYCODE_HOME = previousHome;
  await rm(root, { recursive: true, force: true });
}
