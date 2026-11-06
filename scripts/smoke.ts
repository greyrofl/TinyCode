/**
 * Layout smoke test: renders representative content and verifies that no line
 * exceeds the requested width. Run with `npm run smoke`.
 */
import { renderMarkdown } from "../src/tui/markdown.js";
import { Picker, renderPicker } from "../src/tui/picker.js";
import { getPalette } from "../src/tui/theme.js";
import { buildLogo, logoWidth } from "../src/tui/logo.js";
import { Transcript } from "../src/tui/transcript.js";
import { lineWidth, type Line } from "../src/tui/types.js";
import { TinyCodeTui } from "../src/tui/app.js";
import { Bus } from "../src/core/bus.js";
import { ChatService } from "../src/core/chat.js";
import { defaultConfig, type Config } from "../src/core/config/config.js";
import { buildContext, ContextOverflowError } from "../src/core/context.js";
import { activeMessages } from "../src/core/compaction.js";
import { loadCompactionPrompt } from "../src/core/prompt/compact.js";
import { loadSystemPrompt } from "../src/core/prompt/system.js";
import { SessionStore } from "../src/core/session/store.js";
import type {
  ChatOptions,
  ChatStreamEvent,
  HealthResult,
  ModelInfo,
  Provider,
} from "../src/core/provider/types.js";
import { Editor, wrapChars } from "../src/tui/editor.js";
import { KeyParser, type Key } from "../src/tui/keys.js";
import type { Message, Session, ToolPart } from "../src/core/session/types.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { createDefaultTools } from "../src/tools/registry.js";
import { parseToolCalls, ToolCallStreamFilter } from "../src/tools/parse.js";
import { resolveInCwd } from "../src/tools/paths.js";
import type { ToolApprovalRequest, ToolContext } from "../src/tools/types.js";

let failures = 0;

function check(name, lines, width) {
  for (const [index, line] of lines.entries()) {
    const actual = lineWidth(line);
    if (actual > width) {
      failures++;
      console.error(`FAIL ${name} line ${index}: width ${actual} > ${width}`);
    }
  }
  console.log(`ok ${name} (${lines.length} lines, width ${width})`);
}

const palette = getPalette("dark");
for (const theme of ["dark", "light"] as const) {
  const themePalette = getPalette(theme);
  const logo = buildLogo(themePalette);
  const compactLogo = buildLogo(themePalette, true);
  const color = theme === "dark" ? "#ffffff" : "#181818";
  if (logo.length !== 4 || logoWidth(logo) !== 47 || logo.some((line) => lineWidth(line) !== 47)) {
    failures++;
    console.error(`FAIL ${theme} pixel logo geometry`, logo);
  }
  if (logo.some((line) => line.length !== 1 || line[0]?.style?.fg !== color || !/^[ ▀▄█]+$/.test(line[0]?.text ?? ""))) {
    failures++;
    console.error(`FAIL ${theme} logo must be monochrome pixels`, logo);
  }
  if (compactLogo.length !== 1 || logoWidth(compactLogo) !== 8 || compactLogo[0]?.[0]?.text !== "TinyCode" || compactLogo[0]?.[0]?.style?.fg !== color) {
    failures++;
    console.error(`FAIL ${theme} compact monochrome logo`, compactLogo);
  }
}
console.log("ok monochrome pixel logo / consistent cells / compact and light-theme contrast");
const markdown = [
  "# Heading with a very long title that should wrap gracefully across the line",
  "",
  "A paragraph with **bold text**, *italic text*, `inline code` and a [link](https://example.com).",
  "It continues on the next source line and should be joined into one paragraph.",
  "",
  "- bullet one with a fairly long description that must wrap somewhere near the edge",
  "  1. nested number",
  "> a quoted line that is long enough to wrap around the terminal width",
  "",
  "```js",
  "const value = 'this line of code is intentionally much longer than the terminal width';",
  "```",
  "",
  "---",
].join("\n");

for (const width of [24, 40, 80, 120]) {
  check(`markdown@${width}`, renderMarkdown(markdown, width, palette), width);
}

const messages: Message[] = [
  {
    id: "m1",
    role: "user",
    createdAt: Date.now() - 2000,
    parts: [{ type: "text", text: "Привет! Explain the architecture in a few words." }],
  },
  {
    id: "m2",
    role: "assistant",
    createdAt: Date.now() - 1000,
    model: "qwen2.5-coder:7b",
    parts: [
      { type: "reasoning", text: "We need a short answer.\nIt should mention modules." },
      {
        type: "text",
        text:
          "TinyCode separates **core** (sessions, providers, chat loop) from the **TUI**.\n\n" +
          "### Layers\n1. provider\n2. session store\n3. chat service\n4. terminal UI\n\n" +
          "```ts\nfor await (const event of provider.chat(options)) { /* render */ }\n```\n",
      },
      {
        type: "tool",
        callId: "call_smoke",
        tool: "read_file",
        input: { path: "src/core/chat.ts" },
        status: "completed",
        title: "src/core/chat.ts",
        output:
          "File: src/core/chat.ts (lines 1-40 of 40)\n\n" +
          "import type { Config } from './config.js';\n".repeat(8),
        startedAt: Date.now() - 900,
        endedAt: Date.now() - 800,
      },
      { type: "text", text: "The tool output is shown in a separate block." },
    ],
    usage: { promptTokens: 120, completionTokens: 260, totalTokens: 380, tokensPerSecond: 21.4 },
  },
  {
    id: "m3",
    role: "assistant",
    createdAt: Date.now(),
    model: "qwen2.5-coder:7b",
    parts: [],
    error: "Cannot reach Ollama at http://127.0.0.1:11434. Is the server running?",
  },
];

const transcript = new Transcript(palette);
transcript.sync(messages);
for (const width of [24, 40, 80]) {
  check(`transcript@${width}`, transcript.build(width), width);
}

const picker = new Picker({
  title: "Select model",
  items: [
    { value: "qwen2.5-coder:7b", label: "qwen2.5-coder:7b", detail: "7.6B · Q4_K_M · 4.7 GB" },
    { value: "llama3.2:3b", label: "llama3.2:3b", detail: "3.2B · Q4_K_M · 2.0 GB" },
  ],
});
for (const width of [40, 80, 120]) {
  for (const height of [20, 40]) {
    const rendered = renderPicker(picker, width, height, palette);
    check(`picker@${width}x${height}`, rendered.lines, width);
  }
}

const contextPicker = new Picker({
  title: "Ollama context window",
  message: "Max context: ≈65,536 tokens (memory estimate). Loaded: 8,192 · mixed. RAM ctx means model + context are not fully VRAM-resident.",
  showFilter: false,
  selected: "8192",
  items: [
    { value: "2048", label: "2,048 tokens", detail: "needs ≥4,096", disabled: true },
    { value: "4096", label: "4,096 tokens", detail: "RAM ctx" },
    { value: "8192", label: "8,192 tokens", detail: "RAM ctx · current" },
    { value: "65536", label: "65,536 tokens", detail: "RAM ctx · estimated max" },
    { value: "custom", label: "Custom size…", detail: "type /context <tokens>" },
  ],
});
for (const width of [32, 40, 80]) {
  const rendered = renderPicker(contextPicker, width, 20, palette);
  check(`context-picker@${width}x20`, rendered.lines, width);
}

picker.filter = "llama";
const filtered = picker.items;
const pickerResult = picker.handleKey({ name: "enter" });
if (
  filtered.length !== 1 ||
  pickerResult.type !== "select" ||
  pickerResult.item.value !== "llama3.2:3b" ||
  picker.handleKey({ name: "escape" }).type !== "cancel"
) {
  failures++;
  console.error("FAIL picker filtering/selection");
} else {
  console.log("ok picker behavior");
}

const session: Session = {
  meta: {
    id: "ses_smoke_test",
    title: "A very long session title that needs to be clipped on narrow terminals",
    model: "qwen2.5-coder:7b",
    cwd: "C:\\Users\\example\\project",
    createdAt: Date.now() - 60_000,
    updatedAt: Date.now(),
    messageCount: 2,
  },
  messages: messages.slice(0, 2),
};

function renderTui(
  width: number,
  height: number,
  busy = false,
  welcome = false,
  approval: ToolApprovalRequest | null = null,
  profile: Config["tools"]["profile"] = "auto",
): { frameWidths: number[]; cursor: unknown; footer: string } {
  const current = welcome ? { ...session, messages: [] } : session;
  const chat = {
    current,
    status: busy ? { state: "responding" } : { state: "idle" },
    busy,
    currentModel: session.meta.model,
    currentProvider: "ollama",
    engineName: "Ollama",
    toolsEnabled: true,
    toolCount: 28,
    toolDefinitions: createDefaultTools().definitions(),
    currentThinking: "off",
    currentToolProfile: profile,
    contextLimit: 8192,
    contextUsage: { tokens: 2000, inputTokens: 1900, outputTokens: 100, maxTokens: 8192, percent: 24, estimated: true },
    contextPressure: 0.24,
  };
  const tui = new TinyCodeTui({
    chat: chat as never,
    bus: new Bus(),
    config: defaultConfig(),
    persistedConfig: defaultConfig(),
    configPath: "C:\\Users\\example\\.tinytcode\\config.json",
    cwd: session.meta.cwd,
    promptSource: "promt.md",
  });
  let frame: Line[] = [];
  let cursor = null;
  (tui as unknown as { terminal: { width: number; height: number } }).terminal = { width, height };
  (tui as unknown as { screen: unknown }).screen = {
    resize: () => {},
    clear: () => {},
    render: (value: Line[], position: unknown) => {
      frame = value;
      cursor = position;
    },
  };
  if (approval) {
    (tui as unknown as { approval: unknown }).approval = { request: approval, finish: () => {} };
  }
  (tui as unknown as { render: () => void }).render();
  return { frameWidths: frame.map((line) => lineWidth(line)), cursor, footer: frame.at(-1)?.map((span) => span.text).join("") ?? "" };
}

for (const [width, height] of [
  [40, 20],
  [80, 30],
  [120, 40],
] as const) {
  const { frameWidths, cursor } = renderTui(width, height);
  for (const [index, actual] of frameWidths.entries()) {
    if (actual > width) {
      failures++;
      console.error(`FAIL tui@${width}x${height} row ${index}: width ${actual} > ${width}`);
    }
  }
  if (!cursor || (cursor as { row: number }).row >= height || (cursor as { col: number }).col >= width) {
    failures++;
    console.error(`FAIL tui@${width}x${height}: invalid cursor`, cursor);
  }
  console.log(`ok tui@${width}x${height} (${frameWidths.length} rows)`);
}

const busyFrame = renderTui(80, 24, true);
for (const [index, actual] of busyFrame.frameWidths.entries()) {
  if (actual > 80) {
    failures++;
    console.error(`FAIL busy-tui row ${index}: width ${actual} > 80`);
  }
}
console.log("ok busy tui");

for (const profile of ["auto", "full", "plan", "edit"] as const) {
  for (const width of [24, 32, 40, 80, 120]) {
    for (const busy of [false, true]) {
      const result = renderTui(width, 24, busy, false, null, profile);
      if (!result.footer.includes(`24% · ${profile}`) || result.frameWidths.at(-1)! > width) {
        failures++;
        console.error(`FAIL profile footer@${width} (${profile}, busy=${busy})`, result.footer);
      }
    }
  }
}
console.log("ok tool profile beside context percentage / narrow and busy footer");

for (const [width, height] of [
  [40, 20],
  [80, 24],
  [120, 40],
] as const) {
  const { frameWidths } = renderTui(width, height, false, true);
  for (const [index, actual] of frameWidths.entries()) {
    if (actual > width) {
      failures++;
      console.error(`FAIL welcome@${width}x${height} row ${index}: width ${actual} > ${width}`);
    }
  }
  console.log(`ok welcome@${width}x${height}`);
}

const approvalFrame = renderTui(80, 24, true, false, {
  tool: "execute_command",
  summary: "npm test -- --runInBand",
  detail: "Working directory: C:\\Users\\example\\project",
});
for (const [index, actual] of approvalFrame.frameWidths.entries()) {
  if (actual > 80) {
    failures++;
    console.error(`FAIL approval row ${index}: width ${actual} > 80`);
  }
}
if (approvalFrame.cursor !== null) {
  failures++;
  console.error("FAIL approval dialog should hide the cursor");
}
console.log("ok approval dialog");

// Key parser: arrows, modifiers, bracketed paste, control chords and lone Esc.
const keys: Key[] = [];
const parser = new KeyParser((key) => keys.push(key));
parser.push("a\x1b[A\x1b[1;5C\x1b[200~hi\nthere\x1b[201~\r\n\x1b[<64;10;5M\x1b[<65;10;5M");
parser.push("\x1b");
await new Promise((resolve) => setTimeout(resolve, 80));
parser.dispose();
const keySignature = keys.map((key) =>
  `${key.name}${key.ctrl ? "+ctrl" : ""}${key.alt ? "+alt" : ""}${key.shift ? "+shift" : ""}${
    key.text ? `:${JSON.stringify(key.text)}` : ""
  }`,
);
const expectedKeys = [
  'char:"a"',
  "up",
  "right+ctrl",
  'char:"hi\\nthere"',
  "enter",
  "newline",
  "wheelup",
  "wheeldown",
  "escape",
];
if (JSON.stringify(keySignature) !== JSON.stringify(expectedKeys)) {
  failures++;
  console.error("FAIL key parser", keySignature);
} else {
  console.log("ok key parser");
}

// Editor: word deletion, line editing, wrapping and history.
const editor = new Editor();
editor.setText("hello world");
editor.deleteWordLeft();
if (editor.text !== "hello ") {
  failures++;
  console.error(`FAIL editor deleteWordLeft: ${JSON.stringify(editor.text)}`);
}
editor.setText("line1\nline2");
editor.moveHome();
editor.insert("X");
if (editor.text !== "line1\nXline2") {
  failures++;
  console.error(`FAIL editor line home: ${JSON.stringify(editor.text)}`);
}
const wrapped = wrapChars(Array.from("abcdefghij"), 10, 4);
if (wrapped.lines.length !== 3 || wrapped.cursorRow !== 2 || wrapped.cursorCol !== 2) {
  failures++;
  console.error("FAIL editor wrap", wrapped);
}
editor.loadHistory(["one", "two"]);
editor.historyPrev();
if (editor.text !== "two") {
  failures++;
  console.error("FAIL editor history");
}
console.log("ok editor");

// Context builder: preserve chat, including failed/aborted work and its status.
const history: Message[] = [
  { id: "c1", role: "user", createdAt: 1, parts: [{ type: "text", text: "first" }] },
  { id: "c2", role: "assistant", createdAt: 2, parts: [{ type: "text", text: "ok" }] },
  { id: "c3", role: "user", createdAt: 3, parts: [{ type: "text", text: "second" }] },
  { id: "c4", role: "assistant", createdAt: 4, parts: [{ type: "text", text: "failed" }], error: "boom" },
  { id: "c5", role: "user", createdAt: 5, parts: [{ type: "text", text: "third" }] },
  { id: "c6", role: "assistant", createdAt: 6, parts: [{ type: "text", text: "partial" }], aborted: true },
];
const context = buildContext(history, { maxMessages: 10, maxChars: 10_000 });
const contextText = context.map((message) => `${message.role}:${message.content}`).join("|");
if (contextText !== "user:first|assistant:ok|user:second|assistant:failed\n[Previous turn error: boom]|user:third|assistant:partial\n[Previous turn was aborted; unfinished actions are not completed.]") {
  failures++;
  console.error("FAIL context", contextText);
}
console.log("ok context");

// Text tool protocol: parsing, malformed calls and streaming suppression.
const parsed = parseToolCalls(
  'I will read it.\n<tool_call>{"name":"read_file","arguments":{"path":"a.ts"}}</tool_call>',
);
if (
  parsed.text !== "I will read it." ||
  parsed.calls.length !== 1 ||
  parsed.calls[0]!.name !== "read_file" ||
  parsed.calls[0]!.arguments.path !== "a.ts" ||
  parsed.errors.length !== 0
) {
  failures++;
  console.error("FAIL tool parser", parsed);
}
const malformed = parseToolCalls('<tool_call>{"name":"read_file",</tool_call>');
if (malformed.errors.length === 0) {
  failures++;
  console.error("FAIL malformed tool call should produce an error");
}
const unclosed = parseToolCalls('<tool_call>{"name":"read_file","arguments":{}}');
if (unclosed.errors.length > 0 || unclosed.calls[0]?.name !== "read_file") {
  failures++;
  console.error("FAIL balanced unclosed tool call should be recovered", unclosed);
}
const multiline = parseToolCalls(`<tool_call>{"name":"edit_file","arguments":{"path":"src/a.js","oldText":"return old;
","newText":"return next;
",}}</tool_call>`);
if (
  multiline.errors.length > 0 ||
  multiline.calls[0]?.arguments.oldText !== "return old;\n" ||
  multiline.calls[0]?.arguments.newText !== "return next;\n"
) {
  failures++;
  console.error("FAIL lenient multiline JSON repair", multiline);
}
const filter = new ToolCallStreamFilter();
const visible = [
  "Hello <tool_",
  'call>{"name":"read_file","arguments":{}}</tool_',
  "call> world",
]
  .map((chunk) => filter.push(chunk))
  .join("");
if (visible !== "Hello  world" || filter.flush() !== "") {
  failures++;
  console.error("FAIL stream filter", JSON.stringify(visible));
}
console.log("ok tool protocol");

// Context expansion: tool calls become assistant text + user observations.
const toolMessage: Message = {
  id: "tm",
  role: "assistant",
  createdAt: 7,
  model: "qwen2.5-coder:7b",
  parts: [
    { type: "text", text: "Reading." },
    {
      type: "tool",
      callId: "call1",
      tool: "read_file",
      input: { path: "a.ts" },
      status: "completed",
      output: "content",
    },
    { type: "text", text: "Done." },
  ],
};
const toolContext = buildContext(
  [
    { id: "u", role: "user", createdAt: 1, parts: [{ type: "text", text: "read a.ts" }] },
    toolMessage,
  ],
  { maxMessages: 10, maxChars: 10_000 },
  "SYSTEM",
);
const toolContextText = toolContext.map((message) => `${message.role}:${message.content}`).join("|");
const expectedContext = [
  "system:SYSTEM",
  "user:read a.ts",
  'assistant:Reading.\n<tool_call>{"name":"read_file","arguments":{"path":"a.ts"}}</tool_call>',
  "user:[Observation: content]",
  "assistant:Done.",
].join("|");
if (toolContextText !== expectedContext) {
  failures++;
  console.error("FAIL tool context", toolContextText);
}
console.log("ok tool context");

const longTool: ToolPart = {
  type: "tool",
  callId: "long",
  tool: "read_file",
  input: { path: "large.txt" },
  status: "completed",
  output: "x".repeat(20_000),
};
let overflowRefused = false;
try {
  buildContext(
    [
      { id: "tu", role: "user", createdAt: 1, parts: [{ type: "text", text: "inspect large.txt" }] },
      { id: "ta", role: "assistant", createdAt: 2, parts: [longTool] },
    ],
    { maxMessages: 10, maxChars: 1_000 },
    "SYSTEM",
  );
} catch (error) {
  overflowRefused = error instanceof ContextOverflowError && error.message.includes("No messages were discarded");
}
if (!overflowRefused || longTool.output?.length !== 20_000) {
  failures++;
  console.error("FAIL context overflow must refuse, not truncate", { overflowRefused });
} else {
  console.log("ok context overflow / no silent truncation");
}

class ScriptedProvider implements Provider {
  readonly id = "scripted";
  readonly name = "Scripted";
  readonly requests: ChatOptions[] = [];
  private turn = 0;

  async listModels(): Promise<ModelInfo[]> {
    return [{ id: "scripted", name: "scripted" }];
  }

  async health(): Promise<HealthResult> {
    return { ok: true, version: "test" };
  }

  async *chat(options: ChatOptions): AsyncIterable<ChatStreamEvent> {
    this.requests.push(options);
    const turn = this.turn++;
    if (turn === 0) {
      yield { type: "reasoning", text: "I should read the file first." };
      yield { type: "text", text: '<tool_call>{"name":"read_file","arguments":{"path":"agent.txt"}}</tool_call>' };
    } else if (turn === 1) {
      yield { type: "text", text: '<tool_call>{"name":"replace_file","arguments":{"path":"agent.txt","content":"new\\n"}}</tool_call>' };
    } else if (turn === 2) {
      yield { type: "text", text: '<tool_call>{"name":"read_file","arguments":{"path":"agent.txt"}}</tool_call>' };
    } else {
      yield { type: "text", text: "Done after verification." };
    }
    yield {
      type: "done",
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, tokensPerSecond: 10 },
    };
  }
}

// ChatService agent loop: automatic file tools -> observation -> final turn.
const agentTemp = await mkdtemp(path.join(os.tmpdir(), "tinycode-agent-"));
try {
  await (await import("node:fs/promises")).writeFile(path.join(agentTemp, "agent.txt"), "old\n", "utf8");
  await writeFile(path.join(agentTemp, "AGENTS.md"), "Use the smoke convention.\n", "utf8");
  const provider = new ScriptedProvider();
  const agentConfig = defaultConfig();
  const agentBus = new Bus();
  const chat = new ChatService({
    config: agentConfig,
    provider,
    store: new SessionStore(path.join(agentTemp, ".sessions")),
    bus: agentBus,
    cwd: agentTemp,
    tools: createDefaultTools(),
    systemPrompt: "System cwd={{CWD}}",
  });
  let approvals = 0;
  chat.setApprovalHandler(async () => {
    approvals++;
    return false;
  });
  await chat.initialize({ model: "scripted", cwd: agentTemp });
  await chat.send("replace agent.txt");

  const result = await readFile(path.join(agentTemp, "agent.txt"), "utf8");
  const assistant = chat.current!.messages.at(-1)!;
  const tool = assistant.parts.find((part): part is ToolPart => part.type === "tool" && part.tool === "replace_file");
  const finalText = assistant.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
  const secondRequest = provider.requests[1];
  const sawObservation = secondRequest?.messages.some(
    (message) => message.role === "user" && message.content.includes("[Observation:"),
  );
  const sawSystemCwd = provider.requests[0]?.messages[0]?.content.includes(agentTemp);
  const sawProjectInstructions = provider.requests[0]?.messages[0]?.content.includes("Use the smoke convention");

  if (
    result !== "new\n" ||
    approvals !== 0 ||
    tool?.status !== "completed" ||
    !finalText.includes("Done after verification") ||
    !sawObservation ||
    !sawSystemCwd ||
    !sawProjectInstructions
  ) {
    failures++;
    console.error("FAIL agent loop", {
      result,
      approvals,
      tool,
      finalText,
      sawObservation,
      sawSystemCwd,
      sawProjectInstructions,
    });
  } else {
    console.log("ok agent loop");
  }
} catch (error) {
  failures++;
  console.error("FAIL agent loop:", error);
} finally {
  await rm(agentTemp, { recursive: true, force: true });
}

class CompactProvider implements Provider {
  readonly id = "compact";
  readonly name = "Compact";
  readonly requests: ChatOptions[] = [];

  async listModels(): Promise<ModelInfo[]> {
    return [{ id: "compact", name: "compact" }];
  }

  async health(): Promise<HealthResult> {
    return { ok: true };
  }

  async *chat(options: ChatOptions): AsyncIterable<ChatStreamEvent> {
    this.requests.push(options);
    if (options.messages[0]?.content.includes("COMPACTION TEST PROMPT")) {
      yield {
        type: "text",
        text:
          "## Goal\n- Continue the TinyCode implementation.\n\n" +
          "## Changes completed\n- Older turns were compressed successfully while preserving project facts.\n\n" +
          "## Next step\n- Continue from recent messages and verify changes.",
      };
    } else {
      yield { type: "text", text: "Continued with compacted memory." };
    }
    yield {
      type: "done",
      usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
    };
  }
}

// Manual compaction persists memory, skips old turns, and injects memory later.
const compactTemp = await mkdtemp(path.join(os.tmpdir(), "tinycode-compact-"));
try {
  const config = defaultConfig();
  config.compaction.keepRecentMessages = 4;
  config.compaction.minMessages = 6;
  const provider = new CompactProvider();
  const chat = new ChatService({
    config,
    provider,
    store: new SessionStore(path.join(compactTemp, ".sessions")),
    bus: new Bus(),
    cwd: compactTemp,
    compactionPrompt: "COMPACTION TEST PROMPT",
  });
  await chat.initialize({ model: "compact", cwd: compactTemp });
  const session = chat.current!;
  for (let index = 0; index < 12; index++) {
    session.messages.push({
      id: `old-${index}`,
      role: index % 2 === 0 ? "user" : "assistant",
      createdAt: index + 1,
      model: index % 2 === 0 ? undefined : "compact",
      parts: [{ type: "text", text: `${index % 2 === 0 ? "request" : "answer"} ${index}` }],
    });
  }
  session.meta.messageCount = session.messages.length;
  const compacted = await chat.compact();
  const activeAfter = activeMessages(session);
  await chat.send("continue now");
  const normalRequest = provider.requests.at(-1)!;
  const memoryInjected = normalRequest.messages.some(
    (message) => message.role === "system" && message.content.includes("<session_memory>"),
  );
  const oldSkipped = !normalRequest.messages.some((message) => message.content.includes("request 0"));
  if (
    !compacted.compacted ||
    compacted.strategy !== "model" ||
    activeAfter.length !== 4 ||
    session.meta.compaction?.throughMessageId !== "old-7" ||
    !memoryInjected ||
    !oldSkipped
  ) {
    failures++;
    console.error("FAIL compaction", {
      compacted,
      active: activeAfter.length,
      meta: session.meta.compaction,
      memoryInjected,
      oldSkipped,
    });
  } else {
    console.log("ok session compaction");
  }
} catch (error) {
  failures++;
  console.error("FAIL compaction:", error);
} finally {
  await rm(compactTemp, { recursive: true, force: true });
}

const autoCompactTemp = await mkdtemp(path.join(os.tmpdir(), "tinycode-auto-compact-"));
try {
  const config = defaultConfig();
  config.compaction.threshold = 0.25;
  config.compaction.keepRecentMessages = 2;
  config.compaction.minMessages = 4;
  const provider = new CompactProvider();
  const chat = new ChatService({
    config,
    provider,
    store: new SessionStore(path.join(autoCompactTemp, ".sessions")),
    bus: new Bus(),
    cwd: autoCompactTemp,
    compactionPrompt: "COMPACTION TEST PROMPT",
  });
  await chat.initialize({ model: "compact", cwd: autoCompactTemp });
  for (let index = 0; index < 8; index++) {
    chat.current!.messages.push({
      id: `auto-${index}`,
      role: index % 2 === 0 ? "user" : "assistant",
      createdAt: index + 1,
      parts: [{ type: "text", text: `${"context ".repeat(100)}${index}` }],
    });
  }
  await chat.send("trigger automatic compaction");
  if (!chat.current!.meta.compaction || provider.requests.length < 2) {
    failures++;
    console.error("FAIL automatic compaction", {
      compaction: chat.current!.meta.compaction,
      requests: provider.requests.length,
    });
  } else {
    console.log("ok automatic compaction");
  }
} catch (error) {
  failures++;
  console.error("FAIL automatic compaction:", error);
} finally {
  await rm(autoCompactTemp, { recursive: true, force: true });
}

// File tools and command tool, using a temp directory.
const temp = await mkdtemp(path.join(os.tmpdir(), "tinycode-tools-"));
const config: Config = defaultConfig();
const abort = new AbortController();
const toolContextRun: ToolContext = { cwd: temp, config, signal: abort.signal };
const registry = createDefaultTools();
const systemPrompt = loadSystemPrompt(registry.definitions(), config);
const compactPrompt = loadCompactionPrompt(config);
if (
  systemPrompt.usedFallback ||
  !systemPrompt.text.includes("### create_file") ||
  !systemPrompt.text.includes("### execute_command") ||
  systemPrompt.text.includes("TOOL DEFINITIONS PLACEHOLDER") ||
  !systemPrompt.text.includes("{{CWD}}")
) {
  failures++;
  console.error("FAIL system prompt injection", systemPrompt.source);
} else {
  console.log("ok system prompt injection");
}
if (compactPrompt.usedFallback || !compactPrompt.text.includes("## Goal")) {
  failures++;
  console.error("FAIL compaction prompt loading", compactPrompt.source);
} else {
  console.log("ok compaction prompt loading");
}
try {
  const create = registry.get("create_file")!;
  const created = await create.run(
    { path: "sub/hello.txt", content: "hello tool\n" },
    toolContextRun,
  );
  if (!created.ok) throw new Error(created.output);
  if ((await readFile(path.join(temp, "sub/hello.txt"), "utf8")) !== "hello tool\n") {
    throw new Error("create_file did not write the expected content");
  }

  const duplicate = await create.run({ path: "sub/hello.txt", content: "x" }, toolContextRun);
  if (duplicate.ok) throw new Error("create_file should fail when the file exists");

  const read = registry.get("read_file")!;
  const readResult = await read.run({ path: "sub/hello.txt" }, toolContextRun);
  if (!readResult.ok || !readResult.output.includes("hello tool")) {
    throw new Error(`read_file failed: ${readResult.output}`);
  }

  const replace = registry.get("replace_file")!;
  const replaced = await replace.run(
    { path: "sub/hello.txt", content: "replaced\n" },
    toolContextRun,
  );
  if (!replaced.ok) throw new Error(replaced.output);

  const edit = await registry.get("edit_file")!.run(
    { path: "sub/hello.txt", oldText: "replaced", newText: "edited" },
    toolContextRun,
  );
  if (!edit.ok) throw new Error(edit.output);

  const patch = [
    "--- a/sub/hello.txt",
    "+++ b/sub/hello.txt",
    "@@ -1 +1 @@",
    "-edited",
    "+patched",
    "",
  ].join("\n");
  const patched = await registry.get("apply_patch")!.run({ patch }, toolContextRun);
  if (!patched.ok || (await readFile(path.join(temp, "sub/hello.txt"), "utf8")).trim() !== "patched") {
    throw new Error(`apply_patch failed: ${patched.output}`);
  }

  await writeFile(path.join(temp, "sub", "other.ts"), "export const answer = 42;\n", "utf8");
  const found = await registry.get("find_files")!.run(
    { path: ".", pattern: "**/*.txt" },
    toolContextRun,
  );
  if (!found.ok || !found.output.includes("sub/hello.txt")) throw new Error(found.output);

  const searched = await registry.get("search_text")!.run(
    { path: ".", query: "answer", include: "**/*.ts" },
    toolContextRun,
  );
  if (!searched.ok || !searched.output.includes("other.ts:1")) throw new Error(searched.output);

  const many = await registry.get("read_files")!.run(
    { paths: ["sub/hello.txt", "sub/other.ts"] },
    toolContextRun,
  );
  if (!many.ok || !many.output.includes("patched") || !many.output.includes("answer = 42")) {
    throw new Error(many.output);
  }

  const info = await registry.get("file_info")!.run({ path: "sub/hello.txt" }, toolContextRun);
  if (!info.ok || !info.output.includes("Type: file")) throw new Error(info.output);

  const made = await registry.get("make_directory")!.run({ path: "copies" }, toolContextRun);
  if (!made.ok) throw new Error(made.output);
  const copied = await registry.get("copy_path")!.run(
    { source: "sub/hello.txt", destination: "copies/copied.txt" },
    toolContextRun,
  );
  if (!copied.ok) throw new Error(copied.output);
  const moved = await registry.get("move_path")!.run(
    { source: "copies/copied.txt", destination: "copies/moved.txt" },
    toolContextRun,
  );
  if (!moved.ok) throw new Error(moved.output);

  const list = registry.get("list_dir")!;
  const listed = await list.run({ path: "." }, toolContextRun);
  if (!listed.ok || !listed.output.includes("sub/")) throw new Error(listed.output);

  const command = registry.get("execute_command")!;
  const executed = await command.run(
    { command: 'node -e "console.log(6*7)"' },
    toolContextRun,
  );
  if (!executed.ok || !executed.output.includes("42")) {
    throw new Error(`execute_command failed: ${executed.output}`);
  }

  const gitInit = await command.run(
    {
      command:
        "git init && git config user.email smoke@local && git config user.name smoke && git add . && git commit -m smoke",
    },
    toolContextRun,
  );
  if (!gitInit.ok) throw new Error(`git setup failed: ${gitInit.output}`);
  const gitStatus = await registry.get("git_status")!.run({}, toolContextRun);
  if (!gitStatus.ok || !gitStatus.output.includes("##")) throw new Error(gitStatus.output);

  const dirty = await registry.get("edit_file")!.run(
    { path: "sub/hello.txt", oldText: "patched", newText: "dirty" },
    toolContextRun,
  );
  if (!dirty.ok) throw new Error(dirty.output);
  const gitDiff = await registry.get("git_diff")!.run({ path: "sub/hello.txt" }, toolContextRun);
  if (!gitDiff.ok || !gitDiff.output.includes("+dirty")) throw new Error(gitDiff.output);
  const gitLog = await registry.get("git_log")!.run({ limit: 2 }, toolContextRun);
  if (!gitLog.ok || !gitLog.output.includes("smoke")) throw new Error(gitLog.output);
  const gitShow = await registry.get("git_show")!.run({ ref: "HEAD", path: "sub/hello.txt" }, toolContextRun);
  if (!gitShow.ok || !gitShow.output.includes("patched")) throw new Error(gitShow.output);

  const started = await registry.get("start_process")!.run(
    { command: 'node -e "console.log(\'bg-ready\'); setTimeout(()=>{},10000)"', name: "smoke-bg" },
    toolContextRun,
  );
  const processId = /Started (proc_[A-Za-z0-9]+)/.exec(started.output)?.[1];
  if (!started.ok || !processId) throw new Error(started.output);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const processStatus = await registry.get("process_status")!.run({ id: processId }, toolContextRun);
  if (!processStatus.ok || !processStatus.output.includes("bg-ready")) throw new Error(processStatus.output);
  const processList = await registry.get("list_processes")!.run({}, toolContextRun);
  if (!processList.ok || !processList.output.includes(processId)) throw new Error(processList.output);
  const stopped = await registry.get("stop_process")!.run({ id: processId }, toolContextRun);
  if (!stopped.ok) throw new Error(stopped.output);

  const server = createServer((request, response) => {
    void request;
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true,"source":"smoke"}');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");
    const fetched = await registry.get("fetch_url")!.run(
      { url: `http://127.0.0.1:${address.port}/docs` },
      toolContextRun,
    );
    if (!fetched.ok || !fetched.output.includes('"source":"smoke"')) throw new Error(fetched.output);
  } finally {
    server.close();
    await once(server, "close");
  }

  const say = registry.get("say")!;
  const said = await say.run({ message: "hi" }, toolContextRun);
  if (!said.ok || said.userMessage !== "hi" || said.stop !== true) {
    throw new Error("say tool returned an unexpected result");
  }

  const deleted = await registry.get("delete_file")!.run(
    { path: "sub/hello.txt" },
    toolContextRun,
  );
  if (!deleted.ok) throw new Error(deleted.output);
  const deletedDirectory = await registry.get("delete_directory")!.run(
    { path: "copies", recursive: true },
    toolContextRun,
  );
  if (!deletedDirectory.ok) throw new Error(deletedDirectory.output);

  let escaped = false;
  try {
    resolveInCwd(temp, "../outside.txt");
  } catch {
    escaped = true;
  }
  if (!escaped) throw new Error("resolveInCwd should reject paths outside the cwd");

  console.log("ok all tool families");
} catch (error) {
  failures++;
  console.error("FAIL tools:", error);
} finally {
  registry.dispose();
  await rm(temp, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} layout failure(s)`);
  process.exit(1);
}
console.log("\nall layout checks passed");
