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
import { OllamaProvider } from "../src/core/provider/ollama.js";
import { SessionStore } from "../src/core/session/store.js";
import { TinyCodeTui } from "../src/tui/app.js";
import { createDefaultTools } from "../src/tools/registry.js";

// Never write smoke sessions into the real ~/.tinytcode unless asked.
process.env.TINYCODE_HOME ??= path.join(os.tmpdir(), `tinycode-tui-smoke-${process.pid}`);

const loaded = await loadConfig();
const tools = createDefaultTools();
const prompt = loadSystemPrompt(tools.definitions(), loaded.config);
const compactPrompt = loadCompactionPrompt(loaded.config);
const bus = new Bus();
const provider = new OllamaProvider({
  baseUrl: loaded.config.ollama.baseUrl,
  timeoutMs: loaded.config.ollama.timeoutMs,
  keepAlive: loaded.config.ollama.keepAlive,
  headers: loaded.config.ollama.headers,
});
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
