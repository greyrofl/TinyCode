/**
 * Headless TUI lifecycle smoke test. Feeds `/help` and `/quit` into the real
 * Terminal/KeyParser/TinyCodeTui stack and verifies a clean shutdown.
 * Output is ANSI, so redirect it to a file:
 *
 *   npx tsx scripts/tui-smoke.ts > tui.log
 */
import process from "node:process";
import os from "node:os";
import path from "node:path";
import { Bus } from "../src/core/bus.js";
import { ChatService } from "../src/core/chat.js";
import { loadConfig } from "../src/core/config/config.js";
import { loadCompactionPrompt } from "../src/core/prompt/compact.js";
import { loadSystemPrompt } from "../src/core/prompt/system.js";
import type { ChatOptions, ChatStreamEvent, LoadModelOptions, ModelDetails, Provider, RunningModelInfo } from "../src/core/provider/types.js";
import { SessionStore } from "../src/core/session/store.js";
import { TinyCodeTui } from "../src/tui/app.js";
import { createDefaultTools } from "../src/tools/registry.js";
import type { Picker } from "../src/tui/picker.js";
import type { Key } from "../src/tui/keys.js";

// Never write smoke sessions into the real ~/.tinytcode unless asked.
const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Temp", "opencode") : os.tmpdir();
process.env.TINYCODE_HOME ??= path.join(base, `tinycode-tui-smoke-${process.pid}`);

class MockProvider implements Provider {
  id = "mock";
  name = "Mock Ollama";
  running: RunningModelInfo | null = null;
  async health() { return { ok: true, version: "mock" }; }
  async listModels() { return []; }
  async getModelDetails(model: string): Promise<ModelDetails> {
    return { id: model, name: model, contextLength: 131072, thinking: { modes: ["off"], defaultMode: "off", control: "none" } };
  }
  async getRunningModel() { return this.running; }
  async loadModel(options: LoadModelOptions) {
    return this.running = { id: options.model, sizeBytes: 4_000_000_000, sizeVramBytes: 4_000_000_000, contextLength: options.numCtx };
  }
  async *chat(options: ChatOptions): AsyncIterable<ChatStreamEvent> {
    const observed = options.messages.some((message) => message.role === "user" && message.content.trimStart().startsWith("[Observation:"));
    yield { type: "text", text: observed ? "Done: inspected the working directory." : '<tool_call>{"name":"list_dir","arguments":{"path":"."}}</tool_call>' };
    yield { type: "done", usage: { promptTokens: 100, completionTokens: 12, totalTokens: 112 } };
  }
}

const loaded = await loadConfig();
loaded.config.model = "mock-model:7b";
const tools = createDefaultTools();
const prompt = loadSystemPrompt(tools.definitions(), loaded.config);
const compactPrompt = loadCompactionPrompt(loaded.config);
const bus = new Bus();
const provider = new MockProvider();
const store = new SessionStore();
const chat = new ChatService({
  config: loaded.config,
  provider,
  store,
  bus,
  cwd: process.cwd(),
  tools,
  systemPrompt: prompt.text,
  compactionPrompt: compactPrompt.text,
});
await chat.initialize({});

const tui = new TinyCodeTui({
  chat,
  bus,
  config: loaded.config,
  persistedConfig: loaded.fileConfig,
  configPath: loaded.path,
  cwd: process.cwd(),
  promptSource: prompt.source,
  compactionPromptSource: compactPrompt.source,
});
const controls = tui as unknown as {
  picker: Picker | null;
  openContextPicker(...args: unknown[]): Promise<void>;
  handlePickerKey(key: Key): void;
};
const openPicker = controls.openContextPicker.bind(tui);
controls.openContextPicker = async (...args) => {
  await openPicker(...args);
  setTimeout(() => {
    if (!controls.picker) return;
    const current = controls.picker.items.findIndex((item) => item.value === String(chat.loadedRunnerContext) && !item.disabled);
    if (current >= 0) controls.picker.index = current;
    controls.handlePickerKey({ name: "enter" });
  }, 0);
};

const failTimer = setTimeout(() => {
  process.stderr.write("TUI did not exit in time\n");
  process.exit(2);
}, 5_000);
failTimer.unref();

setTimeout(() => process.stdin.emit("data", "/help\r"), 80);
setTimeout(() => process.stdin.emit("data", "list files\r"), 200);

// Quit after the turn finishes (successfully or with an error).
bus.on("message.ended", () => {
  setTimeout(() => process.stdin.emit("data", "/quit\r"), 120);
});

await tui.run();
tools.dispose();
clearTimeout(failTimer);
const last = chat.current?.messages[chat.current.messages.length - 1];
const usedTools = last?.parts.filter((part) => part.type === "tool").length ?? 0;
process.stdout.write(`TUI exited cleanly (tool parts: ${usedTools})\n`);
