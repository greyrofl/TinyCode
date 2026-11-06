/** Deferred model setup and controlled context restarts. No real Ollama/GPU. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Bus } from "../src/core/bus.js";
import { ChatService } from "../src/core/chat.js";
import { defaultConfig } from "../src/core/config/config.js";
import { estimateContextTokens } from "../src/core/context.js";
import { isOllamaServerProcess, OllamaRuntime, type HardwareMemoryStatus } from "../src/core/ollama-runtime.js";
import { OllamaProvider } from "../src/core/provider/ollama.js";
import type { ChatOptions, ChatStreamEvent, LoadModelOptions, ModelDetails, Provider, RunningModelInfo } from "../src/core/provider/types.js";
import { SessionStore } from "../src/core/session/store.js";
import { textOf } from "../src/core/session/types.js";
import { createDefaultTools } from "../src/tools/registry.js";
import { TinyCodeTui } from "../src/tui/app.js";
import type { Picker } from "../src/tui/picker.js";
import type { Key } from "../src/tui/keys.js";

const GIB = 1024 ** 3;
const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Temp", "opencode") : os.tmpdir();
await mkdir(base, { recursive: true });
const root = await mkdtemp(path.join(base, "tinycode-context-flow-"));
const previousHome = process.env.TINYCODE_HOME;
process.env.TINYCODE_HOME = path.join(root, "home");

class ModelSimulator implements Provider {
  id = "simulated";
  name = "Model simulator";
  running: RunningModelInfo | null = null;
  loads: LoadModelOptions[] = [];
  requests: ChatOptions[] = [];
  events: string[] = [];
  heldVram = 0;
  releaseReads = 0;
  startupFailures = 0;
  otherModelAlive = true;
  blockRelease = false;
  onReleaseWait?: () => void;

  async health() { return { ok: true }; }
  async listModels() { return [{ id: "fake-gemma:26b", name: "fake-gemma:26b", sizeBytes: 6 * GIB }]; }
  async getModelDetails(model: string): Promise<ModelDetails> {
    return {
      id: model, name: model, family: "gemma4", contextLength: 131072,
      contextMemory: { variableKvBytesPerToken: 32768, confidence: "metadata" },
      thinking: { modes: ["off"], defaultMode: "off", control: "none" },
    };
  }
  async getRunningModel(model: string) { return this.running?.id === model ? this.running : null; }
  async loadModel(options: LoadModelOptions): Promise<RunningModelInfo> {
    assert(!options.signal?.aborted);
    assert.equal(this.heldVram, 0, "load must wait for old GPU allocations to disappear");
    this.events.push(`load:${options.numCtx}`);
    this.loads.push(options);
    if (options.numCtx > 8192 && this.startupFailures > 0) {
      this.startupFailures--;
      this.heldVram = 2 * GIB;
      throw new Error("CUDA out of memory during server startup");
    }
    this.running = { id: options.model, sizeBytes: 6 * GIB, sizeVramBytes: 4 * GIB, contextLength: options.numCtx };
    return this.running;
  }
  async unloadModel(model: string): Promise<RunningModelInfo | null> {
    const old = await this.getRunningModel(model);
    if (!old) return null;
    this.events.push("unload");
    this.running = null;
    this.heldVram = old.sizeVramBytes;
    this.releaseReads = 0;
    return old;
  }
  memoryStatus(): HardwareMemoryStatus {
    if (this.heldVram && !this.blockRelease && ++this.releaseReads >= 3) {
      this.heldVram = 0;
      this.events.push("vram-released");
    }
    const used = (this.running?.sizeVramBytes ?? 0) + this.heldVram;
    return {
      ram: { totalBytes: 32 * GIB, freeBytes: 20 * GIB },
      gpus: [{ id: "fake-gpu", name: "fake", totalBytes: 8 * GIB, freeBytes: 7 * GIB - used }],
      source: "simulated memory",
    };
  }
  async *chat(options: ChatOptions): AsyncIterable<ChatStreamEvent> {
    assert(this.running);
    assert.equal(options.options?.num_ctx, this.running.contextLength, "chat must not implicitly reconfigure the runner");
    assert.equal(options.options?.num_batch, this.loads.at(-1)!.runnerOptions?.num_batch);
    assert(estimateContextTokens(options.messages) + Number(options.options?.num_predict) <= Number(options.options?.num_ctx));
    this.events.push("generate");
    this.requests.push(options);
    yield { type: "text", text: "Привет!" };
    yield { type: "done", usage: { promptTokens: estimateContextTokens(options.messages), completionTokens: 4, totalTokens: estimateContextTokens(options.messages) + 4 } };
  }
}

type Controls = {
  terminal: unknown;
  picker: Picker | null;
  pickerKind: string | null;
  openContextPicker(...args: unknown[]): Promise<void>;
  updateContextPickerFooter(): void;
  handlePickerKey(key: Key): void;
  handleEscape(): void;
  transcript: { build(width: number): Array<Array<{ text: string }>> };
};

async function makeUi(name: string, failures = 0, blockRelease = false) {
  const cwd = path.join(root, name);
  await mkdir(cwd, { recursive: true });
  const config = defaultConfig();
  config.model = "fake-gemma:26b";
  config.generation.numPredict = 512;
  const model = new ModelSimulator();
  model.startupFailures = failures;
  model.blockRelease = blockRelease;
  const tools = createDefaultTools();
  const bus = new Bus();
  const store = new SessionStore(path.join(root, `${name}-sessions`));
  const chat = new ChatService({ config, provider: model, tools, bus, store, cwd, systemPrompt: "Test agent" });
  await chat.initialize();
  let serverRestarts = 0;
  const runtime = new OllamaRuntime({ ...config.ollama, baseUrl: "http://127.0.0.1:11998" }, {
    fetch: (async () => new Response('{"version":"simulated"}')) as typeof fetch,
    memoryStatus: async () => model.memoryStatus(),
    restartServer: async () => {
      serverRestarts++;
      model.events.push("server-restart");
      model.running = null;
      model.heldVram = 0;
      model.otherModelAlive = false;
    },
    wait: async (_milliseconds, signal) => {
      if (signal?.aborted) throw new Error("Cancelled.");
      model.events.push("wait");
      model.onReleaseWait?.();
      if (model.blockRelease) await new Promise<void>((_, reject) => {
        if (signal?.aborted) reject(new Error("Cancelled."));
        else signal?.addEventListener("abort", () => reject(new Error("Cancelled.")), { once: true });
      });
    },
  });
  runtime.parallelStatus = async () => ({ value: 1, source: "simulated", local: true, canSet: true });
  const tui = new TinyCodeTui({ chat, bus, config, persistedConfig: structuredClone(config), configPath: path.join(root, "home/config.json"), cwd, runtime });
  const ui = tui as unknown as Controls;
  let input!: (text: string) => void;
  let uiReady!: () => void;
  const ready = new Promise<void>((resolve) => { uiReady = resolve; });
  ui.terminal = {
    width: 80, height: 30, start() {}, stop() {}, write() {}, onResize() {},
    onData(callback: (text: string) => void) { input = callback; uiReady(); },
  };
  const open = ui.openContextPicker.bind(tui);
  const pickerWaiters: Array<() => void> = [];
  ui.openContextPicker = async (...args) => { await open(...args); pickerWaiters.shift()?.(); };
  const nextPicker = () => new Promise<void>((resolve) => pickerWaiters.push(resolve));
  const run = tui.run();
  await ready;
  const choose = (tokens: number) => {
    assert(ui.picker && ui.pickerKind === "context");
    const index = ui.picker.items.findIndex((item) => item.value === String(tokens));
    assert(index >= 0 && !ui.picker.items[index]!.disabled);
    ui.picker.index = index;
    ui.updateContextPickerFooter();
    ui.handlePickerKey({ name: "enter" });
  };
  const stop = async () => { await chat.waitForIdle(); input("/quit\r"); await run; tools.dispose(); };
  return { model, chat, ui, store, input, nextPicker, choose, stop, serverRestarts: () => serverRestarts };
}

try {
  const unchanged = await makeUi("same-context");
  assert.equal(unchanged.model.loads.length, 0, "welcome menu must not load the model");
  const firstPicker = unchanged.nextPicker();
  unchanged.input("Привет\r");
  await firstPicker;
  assert.equal(unchanged.chat.current!.messages.length, 1);
  assert.equal(textOf(unchanged.chat.current!.messages[0]!), "Привет");
  assert.equal(unchanged.model.requests.length, 0);
  assert(unchanged.ui.transcript.build(80).flat().some((span) => span.text.includes("Loading model")));
  assert(!unchanged.ui.picker!.options.footer?.includes("restart required"));
  unchanged.choose(8192);
  await unchanged.chat.waitForIdle();
  assert.equal(unchanged.model.loads.length, 1);
  assert.equal(unchanged.model.requests.length, 1);
  assert.equal(unchanged.serverRestarts(), 0);
  unchanged.input("Ещё привет\r");
  await unchanged.chat.waitForIdle();
  assert.equal(unchanged.model.loads.length, 1);
  await unchanged.stop();
  console.log("ok welcome -> first message -> one load -> context choice -> reply / warm reuse");

  const changed = await makeUi("changed-context");
  const changedPicker = changed.nextPicker();
  changed.input("Привет\r");
  await changedPicker;
  const next = changed.ui.picker!.items.findIndex((item) => item.value === "32768");
  changed.ui.picker!.index = next;
  changed.ui.updateContextPickerFooter();
  assert.match(changed.ui.picker!.options.footer!, /restart required/);
  changed.choose(32768);
  await changed.chat.waitForIdle();
  assert.deepEqual(changed.model.loads.map((item) => item.numCtx), [8192, 32768]);
  assert(changed.model.events.indexOf("vram-released") < changed.model.events.indexOf("load:32768"));
  assert.equal(changed.model.requests.length, 1);
  assert.equal(changed.serverRestarts(), 0);
  assert(changed.model.otherModelAlive, "soft runner reset must leave unrelated models alone");
  assert(changed.ui.transcript.build(80).flat().some((span) => span.text.includes("Restarting ")));
  const saved = await changed.store.load(changed.chat.current!.meta.id);
  assert.equal(saved.meta.numCtx, 32768);
  assert.equal(saved.messages.length, 2);
  await changed.stop();
  console.log("ok changed context -> unload selected model -> VRAM recovery -> reload -> matched generation");

  const recovered = await makeUi("startup-recovery", 1);
  const recoveryPicker = recovered.nextPicker();
  recovered.input("Привет\r");
  await recoveryPicker;
  recovered.choose(32768);
  await recovered.chat.waitForIdle();
  assert.equal(recovered.serverRestarts(), 1);
  assert.equal(recovered.model.requests.length, 1);
  assert.equal(recovered.model.loads.length, 3);
  await recovered.stop();

  const failed = await makeUi("bounded-failure", 9);
  const failurePicker = failed.nextPicker();
  failed.input("Привет\r");
  await failurePicker;
  failed.choose(32768);
  await failed.chat.waitForIdle();
  assert.equal(failed.serverRestarts(), 1);
  assert.equal(failed.model.requests.length, 0);
  assert.equal(failed.model.loads.length, 3, "do not repeatedly retry an allocation that cannot fit");
  assert.equal(failed.chat.contextLimit, 8192);
  assert.match(failed.chat.current!.messages.at(-1)!.error!, /out of memory/);
  assert.equal(textOf(failed.chat.current!.messages[0]!), "Привет");
  await failed.stop();
  console.log("ok one verified-server fallback / bounded OOM retry / original prompt and context retained");

  const cancelled = await makeUi("cancel-selection");
  const cancelPicker = cancelled.nextPicker();
  cancelled.input("Привет\r");
  await cancelPicker;
  cancelled.ui.handlePickerKey({ name: "escape" });
  await cancelled.chat.waitForIdle();
  assert.equal(cancelled.model.requests.length, 0);
  assert.equal(cancelled.chat.current!.messages.at(-1)!.aborted, true);
  const retryPicker = cancelled.nextPicker();
  cancelled.input("/retry\r");
  await retryPicker;
  cancelled.choose(8192);
  await cancelled.chat.waitForIdle();
  assert.equal(cancelled.model.loads.length, 1);
  assert.equal(cancelled.model.requests.length, 1);
  assert.equal(cancelled.chat.current!.messages.length, 2, "retry reuses the original user message");
  await cancelled.stop();

  const cancelRestart = await makeUi("cancel-restart", 0, true);
  const restartPicker = cancelRestart.nextPicker();
  cancelRestart.input("Привет\r");
  await restartPicker;
  let waiting!: () => void;
  const waitStarted = new Promise<void>((resolve) => { waiting = resolve; });
  cancelRestart.model.onReleaseWait = waiting;
  cancelRestart.choose(32768);
  await waitStarted;
  cancelRestart.ui.handleEscape();
  await cancelRestart.chat.waitForIdle();
  assert.equal(cancelRestart.model.loads.length, 1);
  assert.equal(cancelRestart.model.requests.length, 0);
  assert.equal(cancelRestart.serverRestarts(), 0);
  await cancelRestart.stop();
  console.log("ok cancelled picker/restart / no generation or new allocation after cancellation");

  const processInfo = { pid: 101, executable: "C:\\Program Files\\Ollama\\ollama.exe", commandLine: '"C:\\Program Files\\Ollama\\ollama.exe" serve', started: "2026-11-05T12:00:00Z" };
  assert(isOllamaServerProcess(processInfo));
  assert(!isOllamaServerProcess({ ...processInfo, executable: "node.exe" }));
  assert(!isOllamaServerProcess({ ...processInfo, executable: "ollama_llama_server.exe" }));
  assert(!isOllamaServerProcess({ ...processInfo, commandLine: '"C:\\serve\\ollama.exe" run fake' }));
  let remoteRestarts = 0;
  const remote = new OllamaRuntime({ ...defaultConfig().ollama, baseUrl: "http://example.invalid:11434" }, { restartServer: async () => { remoteRestarts++; } });
  await assert.rejects(remote.restartServer(), /owner/);
  assert.equal(remoteRestarts, 0);
  console.log("ok explicit restart scope / reject unrelated processes and remote servers");

  const originalFetch = globalThis.fetch;
  const apiEvents: string[] = [];
  let resident: RunningModelInfo | null = null;
  let loadOptions: Record<string, unknown> = {};
  try {
    globalThis.fetch = (async (url, init) => {
      assert(String(url).startsWith("http://fake.invalid/"));
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (String(url).endsWith("/api/ps")) {
        return new Response(JSON.stringify({ models: resident ? [{ name: resident.id, size: resident.sizeBytes, size_vram: resident.sizeVramBytes, context_length: resident.contextLength }] : [] }));
      }
      if (String(url).endsWith("/api/generate")) {
        assert.equal(body.prompt, "");
        if (body.keep_alive === 0) {
          apiEvents.push("unload");
          resident = null;
        } else {
          assert.equal(body.shift, false);
          assert.equal(body.truncate, false);
          loadOptions = body.options as Record<string, unknown>;
          const tokens = Number(loadOptions.num_ctx);
          apiEvents.push(`load:${tokens}`);
          resident = { id: "api-model:latest", contextLength: tokens, sizeBytes: 6 * GIB, sizeVramBytes: 4 * GIB };
        }
        return new Response(JSON.stringify({ done: true, done_reason: body.keep_alive === 0 ? "unload" : "load", response: "" }));
      }
      assert(String(url).endsWith("/api/chat"));
      const options = body.options as Record<string, unknown>;
      assert(resident && options.num_ctx === resident.contextLength);
      assert.equal(options.num_batch, loadOptions.num_batch);
      assert.equal(body.shift, false);
      assert.equal(body.truncate, false);
      apiEvents.push("generate");
      return new Response(`${JSON.stringify({ message: { content: "Hi" }, done: true, prompt_eval_count: 10, eval_count: 1 })}\n`);
    }) as typeof fetch;
    const provider = new OllamaProvider({ ...defaultConfig().ollama, baseUrl: "http://fake.invalid" });
    await provider.loadModel({ model: "api-model", numCtx: 8192, runnerOptions: { num_batch: 256 } });
    const old = await provider.unloadModel("api-model");
    assert.equal(old?.contextLength, 8192);
    assert.equal(await provider.getRunningModel("api-model"), null);
    await provider.loadModel({ model: "api-model", numCtx: 32768, runnerOptions: { num_batch: 256 } });
    for await (const _ of provider.chat({ model: "api-model", messages: [{ role: "user", content: "Hi" }], options: { num_ctx: 32768, num_batch: 256, num_predict: 10 } })) { /* Drain simulated response. */ }
    assert.deepEqual(apiEvents, ["load:8192", "unload", "load:32768", "generate"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
  console.log("ok real provider protocol / unload polling / matching shift, context and batch options");
  console.log("all context lifecycle checks passed");
} finally {
  if (previousHome === undefined) delete process.env.TINYCODE_HOME;
  else process.env.TINYCODE_HOME = previousHome;
  await rm(root, { recursive: true, force: true });
}
