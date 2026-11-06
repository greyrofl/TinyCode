/** File-call truncation and quote-aware protocol tests. No real model calls. */
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Bus } from "../src/core/bus.js";
import { ChatService } from "../src/core/chat.js";
import { defaultConfig } from "../src/core/config/config.js";
import { estimateContextTokens } from "../src/core/context.js";
import type { ChatOptions, ChatStreamEvent, ModelDetails, Provider } from "../src/core/provider/types.js";
import { SessionStore } from "../src/core/session/store.js";
import { createDefaultTools } from "../src/tools/registry.js";
import { parseToolCalls, ToolCallStreamFilter } from "../src/tools/parse.js";

const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Temp", "opencode") : os.tmpdir();
await mkdir(base, { recursive: true });
const root = await mkdtemp(path.join(base, "tinycode-tool-output-"));
const call = (name: string, args: Record<string, unknown>) => `<tool_call>${JSON.stringify({ name, arguments: args })}</tool_call>`;

class FileWriter implements Provider {
  id = "file-writer";
  name = "File writer simulator";
  requests: ChatOptions[] = [];
  beforeCall?: () => Promise<void>;
  private phase = 0;
  constructor(readonly html: string, readonly neverFinish = false) {}
  async listModels() { return []; }
  async health() { return { ok: true }; }
  async getModelDetails(model: string): Promise<ModelDetails> {
    return { id: model, name: model, family: "gemma4", contextLength: 131072, thinking: { modes: ["off"], defaultMode: "off", control: "none" } };
  }
  async *chat(options: ChatOptions): AsyncIterable<ChatStreamEvent> {
    await this.beforeCall?.();
    this.requests.push(options);
    const limit = Number(options.options?.num_predict);
    assert(estimateContextTokens(options.messages) + limit <= Number(options.options?.num_ctx));
    let text: string;
    let stopReason = "stop";
    let completionTokens = 20;
    if (this.phase === 0) {
      // Gemma's observed order: a long content string, then path at the end.
      const full = call("create_file", { content: this.html, path: "index.html" });
      const required = Math.ceil(Buffer.byteLength(full, "utf8") / 4);
      if (this.neverFinish || limit < required) {
        text = full.slice(0, limit * 4);
        stopReason = "length";
        completionTokens = limit;
      } else {
        text = full;
        completionTokens = required;
        this.phase++;
      }
    } else if (this.phase === 1) {
      text = call("read_file", { path: "index.html", limit: 2000 });
      this.phase++;
    } else text = "Created index.html and checked its contents.";
    yield { type: "text", text };
    yield { type: "done", stopReason, usage: { promptTokens: estimateContextTokens(options.messages), completionTokens, totalTokens: estimateContextTokens(options.messages) + completionTokens } };
  }
}

async function fixture(name: string, html: string, numCtx = 65536, neverFinish = false) {
  const cwd = path.join(root, name);
  await mkdir(cwd, { recursive: true });
  const config = defaultConfig();
  config.model = "fake-gemma:26b";
  config.generation.numCtx = numCtx;
  config.generation.numPredict = 2048;
  const provider = new FileWriter(html, neverFinish);
  const tools = createDefaultTools();
  const bus = new Bus();
  const notices: string[] = [];
  bus.on("notice", ({ text }) => notices.push(text));
  const store = new SessionStore(path.join(root, `${name}-sessions`));
  const chat = new ChatService({ config, provider, tools, store, bus, cwd, systemPrompt: "Test agent" });
  await chat.initialize();
  return { chat, config, provider, tools, cwd, notices, store };
}

try {
  const content = '<html>\n<script>const example = "<tool_call>{\\\"name\\\":\\\"say\\\"}</tool_call>";\nconst literal = ",}"; const values = [1,];</script>\n</html>';
  const protocol = `Before ${call("create_file", { path: "index.html", content })} After`;
  const parsed = parseToolCalls(protocol);
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.calls.length, 1);
  assert.equal(parsed.calls[0]!.arguments.content, content);
  assert.equal(parsed.text, "Before  After");
  for (const size of [1, 2, 7, 13, 31]) {
    const filter = new ToolCallStreamFilter();
    let visible = "";
    for (let index = 0; index < protocol.length; index += size) visible += filter.push(protocol.slice(index, index + size));
    visible += filter.flush();
    assert.equal(visible, "Before  After", `nested tags must stay suppressed with ${size}-character chunks`);
  }
  const rawNewlines = '<tool_call>{"name":"create_file","arguments":{"path":"index.html","content":"first\nliteral </tool_call>\nconst values = [1,]; const text = ,}\nlast",},}</tool_call>';
  const repaired = parseToolCalls(rawNewlines);
  assert.equal(repaired.errors.length, 0);
  assert.equal(repaired.calls[0]!.arguments.content, "first\nliteral </tool_call>\nconst values = [1,]; const text = ,}\nlast");
  const strippedStop = call("create_file", { path: "index.html", content }).slice(0, -"</tool_call>".length);
  assert.equal(parseToolCalls(strippedStop).calls[0]!.arguments.content, content);
  const incomplete = parseToolCalls('<tool_call>{"name":"create_file","arguments":{"content":"<html></tool_call>unfinished');
  assert.equal(incomplete.calls.length, 0);
  assert.equal(incomplete.issues[0]!.kind, "incomplete");
  const native = '<|tool_call>call:listdir{path:"."}<tool_call|>';
  const nativeParsed = parseToolCalls(`Before ${native} After`);
  assert.deepEqual(nativeParsed.calls, [{ name: "list_dir", arguments: { path: "." } }]);
  assert.equal(nativeParsed.text, "Before  After");
  for (const size of [1, 3, 11]) {
    const filter = new ToolCallStreamFilter(); let visible = "";
    for (let index = 0; index < native.length; index += size) visible += filter.push(native.slice(index, index + size));
    visible += filter.flush(); assert.equal(visible, "", `native tool DSL must be hidden at chunk size ${size}`);
  }
  console.log("ok literal tool tags inside content / streaming split tags / JSON repair preserves file bytes");

  const html = `<!doctype html>\n<html lang="ru"><head><title>TinyCode</title></head><body>\n${"<p>TinyCode — local code</p>\n".repeat(700)}\n<script>const example="<tool_call>hi</tool_call>";</script>\n</body></html>\n`;
  const writer = await fixture("adaptive", html);
  let incompleteChecks = 0;
  writer.provider.beforeCall = async () => {
    if (writer.provider.requests.length < 2) {
      await assert.rejects(access(path.join(writer.cwd, "index.html")), { code: "ENOENT" });
      incompleteChecks++;
    }
  };
  await writer.chat.send("Create index.html with the requested page.");
  assert.equal(writer.chat.current!.messages.at(-1)!.outcome, "completed", writer.chat.current!.messages.at(-1)!.error);
  assert.equal(await readFile(path.join(writer.cwd, "index.html"), "utf8"), html);
  assert.deepEqual(writer.provider.requests.slice(0, 3).map((request) => request.options?.num_predict), [2048, 4096, 8192]);
  assert.equal(incompleteChecks, 2);
  assert.equal(writer.config.generation.numPredict, 2048, "repair budget does not change persistent settings");
  assert(writer.notices.some((notice) => notice.includes("2048") && notice.includes("4096")));
  assert(writer.provider.requests[1]!.messages.some((message) => message.content.includes("Truncated create_file") && message.content.includes("no partial file")));
  const errors = writer.chat.current!.messages.at(-1)!.parts.filter((part) => part.type === "tool" && part.synthetic);
  assert.equal(errors.length, 2);
  assert.equal((await writer.store.load(writer.chat.current!.meta.id)).meta.lastContext?.outputLimit, 8192);
  assert.equal(writer.chat.current!.meta.lastContext?.stopReason, "stop");
  writer.tools.dispose();
  console.log("ok 2048 -> 4096 -> 8192 repair / complete content-first call / read-back verification");

  const never = await fixture("bounded", html.repeat(3), 65536, true);
  await never.chat.send("Create index.html with a very large page.");
  await assert.rejects(access(path.join(never.cwd, "index.html")), { code: "ENOENT" });
  assert.equal(never.provider.requests.length, 4);
  assert.match(never.chat.current!.messages.at(-1)!.error!, /repeatedly exceeded the output budget/);
  assert(never.provider.requests.at(-1)!.messages.some((message) => message.content.includes("unique placeholder") && message.content.includes("read_file")));
  assert.equal(never.chat.current!.meta.lastContext?.stopReason, "length");
  never.tools.dispose();

  const small = await fixture("small-context", html, 4096, true);
  await small.chat.send("Create index.html with a very large page.");
  await assert.rejects(access(path.join(small.cwd, "index.html")), { code: "ENOENT" });
  assert.equal(small.provider.requests.length, 2, "when context cannot provide more output, switch directly to small complete edits");
  assert(small.provider.requests.every((request) => Number(request.options?.num_predict) <= Number(request.options?.num_ctx) - estimateContextTokens(request.messages)));
  small.tools.dispose();
  console.log("ok bounded repeated truncation / chunk alternative / no partial writes or oversized requests");
  console.log("all tool output checks passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
