/** llama.cpp installation, lifecycle, protocol and engine selection. No real binaries/weights/network. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { Bus } from "../src/core/bus.js";
import { ChatService } from "../src/core/chat.js";
import { defaultConfig, mergeConfig } from "../src/core/config/config.js";
import { LocalEngines } from "../src/core/engines.js";
import { LlamaInstaller, safeArchivePath, selectLlamaAssets, type LlamaReleaseAsset } from "../src/core/llama-install.js";
import { LlamaRuntime } from "../src/core/llama-runtime.js";
import { calculateContextCapacity } from "../src/core/context-memory.js";
import { GgufCatalog, readGgufMetadata } from "../src/core/provider/gguf.js";
import { LlamaProvider } from "../src/core/provider/llama.js";
import { ProviderRegistry } from "../src/core/provider/registry.js";
import type { ChatOptions, ChatStreamEvent, LoadModelOptions, ModelDetails, Provider, RunningModelInfo } from "../src/core/provider/types.js";
import type { LocalRuntime } from "../src/core/runtime.js";
import { SessionStore } from "../src/core/session/store.js";
import { textOf } from "../src/core/session/types.js";
import { TinyCodeTui } from "../src/tui/app.js";
import type { Picker } from "../src/tui/picker.js";
import type { Key } from "../src/tui/keys.js";
import { createDefaultTools } from "../src/tools/registry.js";

const MIB = 1024 ** 2, GIB = 1024 ** 3;
const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Temp", "opencode") : os.tmpdir();
await mkdir(base, { recursive: true });
const root = await mkdtemp(path.join(base, "tinycode-engines-"));
const environment = { TINYCODE_HOME: process.env.TINYCODE_HOME, OLLAMA_MODELS: process.env.OLLAMA_MODELS, LLAMA_CACHE: process.env.LLAMA_CACHE };
process.env.TINYCODE_HOME = path.join(root, "home");
process.env.OLLAMA_MODELS = path.join(root, "ollama-cache");
process.env.LLAMA_CACHE = path.join(root, "llama-cache");

const json = (value: unknown) => new Response(JSON.stringify(value));
const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const u64 = (value: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(value)); return b; };
const u32 = (value: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(value); return b; };
const string = (value: string) => { const b = Buffer.from(value); return Buffer.concat([u64(b.length), b]); };
const metadata = [
  ["general.architecture", "qwen3"], ["general.name", "Simulated 7B"], ["general.size_label", "7B"],
  ["qwen3.context_length", 131072], ["qwen3.block_count", 32], ["qwen3.embedding_length", 4096],
  ["qwen3.attention.head_count", 32], ["qwen3.attention.head_count_kv", 8],
  ["tokenizer.chat_template", "{% if enable_thinking %}<think>{% endif %}"],
] as const;
const modelBytes = Buffer.concat([
  Buffer.from("GGUF"), u32(3), u64(0), u64(metadata.length + 1),
  ...metadata.map(([key, value]) => Buffer.concat([string(key), u32(typeof value === "number" ? 4 : 8), typeof value === "number" ? u32(value) : string(value)])),
  string("tokenizer.ggml.tokens"), u32(9), u32(8), u64(1200),
  ...Array.from({ length: 1200 }, (_, index) => string(`unused-token-${index}`)),
  Buffer.alloc(64 * 1024, 123), // Fake tensor bytes must never be read as metadata.
]);
const modelFile = path.join(root, "simulated-7B-Q4_K_M.gguf");
await writeFile(modelFile, modelBytes);
const tinyGguf = (entries: Array<[string, string | number]>) => Buffer.concat([
  Buffer.from("GGUF"), u32(3), u64(0), u64(entries.length),
  ...entries.map(([key, value]) => Buffer.concat([string(key), u32(typeof value === "number" ? 4 : 8), typeof value === "number" ? u32(value) : string(value)])),
]);
const embeddedFile = path.join(root, "Qwen3.6-35B-A3B-MTP-UD-IQ4_XS.gguf");
const embeddedBytes = tinyGguf([
  ["general.architecture", "qwen35moe"], ["general.name", "Qwen3.6 35B A3B"], ["general.size_label", "35B"],
  ["qwen35moe.context_length", 262144], ["qwen35moe.block_count", 41], ["qwen35moe.nextn_predict_layers", 1],
  ["tokenizer.chat_template", "{% if enable_thinking %}<think>{% endif %}"],
]);
const sidecarBytes = tinyGguf([["general.architecture", "gemma4-assistant"], ["general.name", "Gemma MTP sidecar"]]);
await writeFile(embeddedFile, embeddedBytes);

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: string | null = null;
  pid = 30001;
  killed = false;
  stdout = new PassThrough();
  stderr = new PassThrough();
  constructor(readonly onKill: () => void) { super(); }
  kill(signal: string = "SIGTERM") {
    if (this.exitCode !== null || this.signalCode !== null) return false;
    this.killed = true; this.signalCode = signal;
    this.onKill(); this.emit("exit", null, signal); this.emit("close", null, signal);
    this.stdout.end(); this.stderr.end();
    return true;
  }
}

/** HTTP state machine and fake process allocator for the real LlamaRuntime/LlamaProvider. */
class LlamaSimulator {
  child: FakeChild | null = null;
  ready = false;
  model = modelFile;
  alias = "external-model";
  context = 8192;
  slots = 1;
  heldVram = 0;
  releaseReads = 0;
  tokenCount = 12;
  installs = 0;
  blocked = false;
  onWait?: () => void;
  startupFailures = 0;
  endMarker = true;
  events: string[] = [];
  help = "--gpu-layers N\n                       auto or all\n--no-webui\n--no-agent\n--spec-type TYPE\n--spec-draft-model FILE\n--spec-draft-n-max N\n--spec-draft-type-k TYPE\n--spec-draft-type-v TYPE";
  spawns: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
  requests: Array<Record<string, unknown>> = [];
  templates: Array<Record<string, unknown>> = [];
  response: (body: Record<string, unknown>) => unknown[] = () => [
    { choices: [{ delta: { reasoning_content: "Проверю." }, finish_reason: null }] },
    { choices: [{ delta: { content: "Привет!" }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 }, timings: { predicted_per_second: 30 } },
  ];

  memory() {
    if (this.heldVram && ++this.releaseReads >= 3) { this.heldVram = 0; this.events.push("memory-free"); }
    return { ram: { totalBytes: 32 * GIB, freeBytes: 20 * GIB }, gpus: [{ id: "fake", name: "fake GPU", totalBytes: 8 * GIB, freeBytes: 7 * GIB - (this.ready ? 432 * MIB : 0) - this.heldVram }], source: "simulated" };
  }
  fetch = (async (url, init) => {
    const endpoint = new URL(String(url)).pathname;
    assert(!init?.signal?.aborted);
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (endpoint === "/health") return this.ready ? json({ status: "ok" }) : new Response('{"error":{"message":"Loading model"}}', { status: 503 });
    if (endpoint === "/props") return json({ model_path: this.model, default_generation_settings: { n_ctx: this.context }, total_slots: this.slots, build_info: "simulated", chat_template_caps: { supports_enable_thinking: true, reasoning_effort_levels: ["low", "high"] } });
    if (endpoint === "/v1/models") return json({ data: [{ id: this.alias, owned_by: "llamacpp", meta: { n_ctx_train: 131072, size: modelBytes.length } }] });
    assert(this.ready, "no inference request before the fake process is ready");
    if (endpoint === "/apply-template") { this.templates.push(body); return json({ prompt: (body.messages as Array<{ content: string }>).map((m) => m.content).join("\n") }); }
    if (endpoint === "/tokenize") return json({ tokens: Array.from({ length: this.tokenCount }, (_, i) => i) });
    assert.equal(endpoint, "/v1/chat/completions");
    assert.equal(body.model, this.alias);
    assert.equal(body.context_shift, false);
    assert.equal(body.n_keep, -1);
    assert.equal(body.stream, true);
    assert(Number(body.max_tokens) + this.tokenCount < this.context);
    this.requests.push(body);
    const source = `: heartbeat\r\n\r\n${this.response(body).map((chunk) => `data: ${JSON.stringify(chunk)}\r\n\r\n`).join("")}${this.endMarker ? "data: [DONE]\r\n\r\n" : ""}`;
    const data = Buffer.from(source, "utf8");
    return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < data.length; i += 7) controller.enqueue(data.subarray(i, i + 7)); controller.close(); } }), { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  runtime(config = defaultConfig().llama): LlamaRuntime {
    config.models = { "simulated-7B": modelFile, "simulated-26B-A4B": modelFile };
    return new LlamaRuntime(config, root, {
      fetch: this.fetch,
      installer: { locate: async () => "fake-llama-server", ensure: async (signal) => { signal?.throwIfAborted(); this.installs++; return "fake-llama-server"; } },
      capture: async () => this.help,
      checkPort: async () => {}, memoryStatus: async () => this.memory(),
      spawnServer: (_executable, args, env) => {
        assert.equal(this.heldVram, 0, "do not allocate on top of an unreleased runner");
        this.spawns.push({ args, env }); this.events.push(`spawn:${args[args.indexOf("--ctx-size") + 1]}`);
        this.model = args[args.indexOf("--model") + 1]!; this.alias = args[args.indexOf("--alias") + 1]!;
        this.slots = Number(args[args.indexOf("--parallel") + 1]);
        this.context = Number(args[args.indexOf("--ctx-size") + 1]) / this.slots;
        this.child = new FakeChild(() => { this.ready = false; this.heldVram = 432 * MIB; this.releaseReads = 0; this.events.push("stop-owned"); });
        return this.child as unknown as ChildProcess;
      },
      wait: async (_ms, signal) => {
        signal?.throwIfAborted(); this.onWait?.();
        if (this.blocked) await new Promise<void>((_, reject) => {
          if (signal?.aborted) reject(signal.reason);
          else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        if (this.child && !this.child.killed && this.child.exitCode === null && !this.ready) {
          if (this.context > 8192 && this.startupFailures > 0) {
            this.startupFailures--; this.child.stderr.write("CUDA out of memory during llama-server startup\n");
            this.child.exitCode = 1; this.child.emit("exit", 1, null); this.heldVram = 432 * MIB; this.releaseReads = 0;
            return;
          }
          this.child.stderr.write("llama_model_load: CPU_Mapped model buffer size = 800.00 MiB\nllama_model_load: CUDA0 model buffer size = 400.00 MiB\nllama_kv_cache: CUDA0 KV buffer size = 32.00 MiB\n");
          this.ready = true;
        }
      },
    });
  }
}

class OllamaSimulator implements Provider {
  id = "ollama";
  name = "Ollama";
  running: RunningModelInfo | null = null;
  unloads: string[] = [];
  otherModelAlive = true;
  async listModels() { return [{ id: "simulated-ollama:7b", name: "simulated-ollama:7b" }]; }
  async getModelDetails(model: string): Promise<ModelDetails> { return { id: model, name: model, contextLength: 131072, thinking: { modes: ["off"], defaultMode: "off", control: "none" } }; }
  async health() { return { ok: true }; }
  async getRunningModel(model: string) { return this.running?.id === model ? this.running : null; }
  async unloadModel(model: string) {
    const previous = await this.getRunningModel(model);
    this.unloads.push(model); this.running = null;
    return previous;
  }
  async *chat(_options: ChatOptions): AsyncIterable<ChatStreamEvent> { yield { type: "text", text: "Ollama response" }; yield { type: "done", usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 } }; }
}
const inertRuntime: LocalRuntime = {
  available: async () => true, ensureStarted: async () => false, memoryStatus: async () => null,
  waitForMemoryRelease: async () => {}, restartServer: async () => {},
  parallelStatus: async () => ({ value: 1, source: "simulated", local: true, canSet: false }),
  setParallelOne: async () => ({ value: 1, source: "simulated", local: true, canSet: false }),
};

try {
  assert.equal(defaultConfig().provider, "llama.cpp");
  assert.equal(defaultConfig().model, "");
  const legacy = { model: "old:7b", ollama: { timeoutMs: 123456 }, generation: { numCtx: 32768 } };
  const copy = structuredClone(legacy);
  assert.equal(mergeConfig(legacy).provider, "ollama");
  assert.equal(mergeConfig(legacy).model, "old:7b");
  assert.deepEqual(legacy, copy);
  assert.equal(mergeConfig({ provider: "llama.cpp", providerModels: { "llama.cpp": modelFile } }).model, modelFile);
  assert.equal(mergeConfig({ llama: { parallel: 0, batchSize: -1, backend: "invalid" } }).llama.parallel, 1);
  assert.equal(mergeConfig({ llama: { speculativeType: "ngram-mod" } }).llama.speculativeType, "ngram-mod");
  assert.equal(mergeConfig({ llama: { speculativeType: "draft-mtp", speculativeDraftModel: "draft.gguf", speculativeDraftDevice: "cpu", speculativeDraftMax: 5 } }).llama.speculativeDraftMax, 5);
  assert.equal(mergeConfig({ llama: { speculativeType: "invalid" } }).llama.speculativeType, "none");
  assert.equal(mergeConfig({ llama: { speculativeMtpMode: "embedded" } }).llama.speculativeMtpMode, "embedded");
  console.log("ok llama.cpp-first defaults / old Ollama config preserved / engine model defaults");

  let network = 0;
  const installed = new LlamaInstaller(defaultConfig().llama, { findExecutable: async () => "C:/fake/llama-server.exe", fetch: (async () => { network++; throw Error("Unexpected network"); }) as typeof fetch, root: path.join(root, "installed") });
  assert.equal(await installed.ensure(), "C:/fake/llama-server.exe");
  assert.equal(network, 0);
  const archive = Buffer.from("fake official archive");
  const pointerBytes = Buffer.from("b999\n");
  const pointerAsset = { name: "nightly-tag.txt", size: pointerBytes.length, digest: `sha256:${hash(pointerBytes)}`, browser_download_url: "https://github.com/ggml-org/llama.cpp/releases/download/v1.0.0/nightly-tag.txt" };
  const asset: LlamaReleaseAsset = { name: "llama-b999-bin-win-cpu-x64.zip", size: archive.length, digest: `sha256:${hash(archive)}`, browser_download_url: "https://github.com/ggml-org/llama.cpp/releases/download/b999/llama-b999-bin-win-cpu-x64.zip" };
  let extracted = 0, metadataRequests = 0;
  const installConfig = defaultConfig().llama;
  installConfig.backend = "cpu";
  const installDeps = {
    platform: "win32" as const, arch: "x64", root: path.join(root, "install-success"), findExecutable: async () => null,
    capture: async () => "llama.cpp simulated",
    fetch: (async (url) => {
      const value = String(url);
      if (value.endsWith("/releases/latest")) { metadataRequests++; return json({ tag_name: "v1.0.0", assets: [pointerAsset] }); }
      if (value.endsWith("/nightly-tag.txt")) return new Response(pointerBytes);
      if (value.endsWith("/releases/tags/b999")) return json({ tag_name: "b999", assets: [asset] });
      assert.equal(value, asset.browser_download_url); return new Response(archive);
    }) as typeof fetch,
    extract: async (_file: string, destination: string) => { extracted++; await writeFile(path.join(destination, "llama-server.exe"), "fake executable"); },
  };
  const installer = new LlamaInstaller(installConfig, installDeps);
  const [first, second] = await Promise.all([installer.ensure(), installer.ensure()]);
  assert.equal(first, second); assert.equal(extracted, 1); assert.equal(metadataRequests, 1);
  assert.equal(await installer.ensure(), first); assert.equal(metadataRequests, 1);
  const invalid = new LlamaInstaller(installConfig, { ...installDeps, root: path.join(root, "install-invalid"), fetch: (async (url) => String(url).includes("api.github.com") ? json({ tag_name: "b999", assets: [{ ...asset, digest: `sha256:${"0".repeat(64)}` }] }) : new Response(archive)) as typeof fetch });
  await assert.rejects(invalid.ensure(), /verification failed/);
  assert.equal(extracted, 1, "never extract a failed checksum");
  await assert.rejects(access(path.join(root, "install-invalid/current.json")), { code: "ENOENT" });
  const installCancelled = new AbortController();
  const cancelledInstall = new LlamaInstaller(installConfig, { ...installDeps, root: path.join(root, "install-cancelled"), fetch: (async (url) => {
    if (String(url).includes("api.github.com")) return json({ tag_name: "b999", assets: [asset] });
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(archive); installCancelled.abort(new Error("cancelled download")); controller.close(); } }));
  }) as typeof fetch });
  await assert.rejects(cancelledInstall.ensure(installCancelled.signal), /cancelled download/);
  await assert.rejects(access(path.join(root, "install-cancelled/current.json")), { code: "ENOENT" });
  assert.equal(extracted, 1);
  const noInstall = new LlamaInstaller({ ...installConfig, autoInstall: false }, { ...installDeps, root: path.join(root, "install-disabled"), fetch: (async () => { throw Error("Must not fetch"); }) as typeof fetch });
  await assert.rejects(noInstall.ensure(), /enable llama.autoInstall/);
  assert(!safeArchivePath("../escape.exe")); assert(!safeArchivePath("C:/escape.exe")); assert(!safeArchivePath("/escape")); assert(safeArchivePath("./bin/llama-server"));
  const cudaMain = { ...asset, name: "llama-b999-bin-win-cuda-12.4-x64.zip" };
  const cudaRuntime = { ...asset, name: "cudart-llama-bin-win-cuda-12.4-x64.zip" };
  assert.equal(selectLlamaAssets([cudaMain, cudaRuntime], "win32", "x64", "cuda").length, 2);
  assert.throws(() => selectLlamaAssets([cudaMain], "win32", "x64", "cuda"), /matching CUDA/);
  assert.throws(() => selectLlamaAssets([asset], "linux", "ia32", "cpu"), /unavailable/);
  console.log("ok installed executable reuse / stable binary pointer / concurrent and cached install / SHA-256 / CUDA pairing");

  // Exercise the production archive extractor with a tiny valid tar, not an engine download.
  function tarFile(name: string, text: string): Buffer {
    const header = Buffer.alloc(512); const content = Buffer.from(text);
    header.write(name, 0, 100, "utf8"); header.write("0000755\0", 100, "ascii");
    header.write("0000000\0", 108, "ascii"); header.write("0000000\0", 116, "ascii");
    header.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124, "ascii");
    header.write("00000000000\0", 136, "ascii"); header.fill(32, 148, 156); header.write("0", 156, "ascii");
    header.write("ustar\0", 257, "ascii"); header.write("00", 263, "ascii");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
    return gzipSync(Buffer.concat([header, content, Buffer.alloc((512 - content.length % 512) % 512), Buffer.alloc(1024)]));
  }
  const tarArchive = tarFile("bin/llama-server", "fake server bytes");
  const tarAsset = { ...asset, name: "llama-b999-bin-macos-x64.tar.gz", size: tarArchive.length, digest: `sha256:${hash(tarArchive)}` };
  const tarInstaller = new LlamaInstaller({ ...installConfig, release: "b999" }, {
    ...installDeps, platform: "darwin", root: path.join(root, "install-tar"), extract: undefined,
    fetch: (async (url) => String(url).includes("api.github.com") ? json({ tag_name: "b999", assets: [tarAsset] }) : new Response(tarArchive)) as typeof fetch,
  });
  assert.equal(await readFile(await tarInstaller.ensure(), "utf8"), "fake server bytes");
  const unsafeTar = tarFile("../escaped-file", "unsafe");
  const unsafeAsset = { ...tarAsset, size: unsafeTar.length, digest: `sha256:${hash(unsafeTar)}` };
  const unsafeInstaller = new LlamaInstaller({ ...installConfig, release: "b999" }, {
    ...installDeps, platform: "darwin", root: path.join(root, "install-unsafe-tar"), extract: undefined,
    fetch: (async (url) => String(url).includes("api.github.com") ? json({ tag_name: "b999", assets: [unsafeAsset] }) : new Response(unsafeTar)) as typeof fetch,
  });
  await assert.rejects(unsafeInstaller.ensure(), /Unsafe path/);
  console.log("ok production tar extraction / reject traversal before extraction / cancelled and disabled installs leave no executable");

  const pinnedConfig = { ...installConfig, release: "v1.0.0" };
  const pinnedInstaller = new LlamaInstaller(pinnedConfig, { ...installDeps, root: path.join(root, "install-pinned"), fetch: (async (url, init) =>
    installDeps.fetch(String(url).replace("/releases/tags/v1.0.0", "/releases/latest"), init)) as typeof fetch });
  const requestsBeforePin = metadataRequests;
  const pinnedPath = await pinnedInstaller.ensure();
  assert.equal(await pinnedInstaller.ensure(), pinnedPath);
  assert.equal(metadataRequests, requestsBeforePin + 1, "a pinned stable release must reuse its resolved binary build");
  const corruptRoot = path.join(root, "install-corrupt-record"); await mkdir(corruptRoot);
  await writeFile(path.join(corruptRoot, "current.json"), '{"executable":42,"tag":"b999","backend":"cpu"}');
  assert.equal(await new LlamaInstaller(installConfig, { ...installDeps, root: corruptRoot }).locate(), null);
  assert.throws(() => selectLlamaAssets([tarAsset], "darwin", "x64", "vulkan"), /does not provide/);
  console.log("ok pinned stable release cache / corrupted install record ignored / no silent backend substitution");

  const parsed = await readGgufMetadata(modelFile);
  assert.equal(parsed["qwen3.context_length"], 131072);
  assert(!("tokenizer.ggml.tokens" in parsed), "tokenizer arrays must not be retained");
  const modelDir = path.join(root, "models"); await mkdir(modelDir);
  await writeFile(path.join(modelDir, "split-7B-00001-of-00010.gguf"), modelBytes);
  await writeFile(path.join(modelDir, "split-7B-00010-of-00010.gguf"), modelBytes);
  await writeFile(path.join(modelDir, "mmproj-fake.gguf"), modelBytes);
  await writeFile(path.join(modelDir, "mtp-simulated-7B-Q8_0.gguf"), sidecarBytes);
  await writeFile(path.join(modelDir, "Qwen3.6-35B-A3B-MTP-UD-IQ4_XS.gguf"), embeddedBytes);
  const digest = "1".repeat(64), manifests = path.join(process.env.OLLAMA_MODELS!, "manifests/registry.ollama.ai/library/simulated-model");
  await mkdir(manifests, { recursive: true }); await mkdir(path.join(process.env.OLLAMA_MODELS!, "blobs"), { recursive: true });
  await writeFile(path.join(manifests, "7b"), JSON.stringify({ layers: [{ mediaType: "application/vnd.ollama.image.model", digest: `sha256:${digest}` }] }));
  await writeFile(path.join(process.env.OLLAMA_MODELS!, "blobs", `sha256-${digest}`), modelBytes);
  const catalog = new GgufCatalog({ ...defaultConfig().llama, models: { alias: modelFile }, modelDirs: [modelDir] }, root);
  const local = await catalog.list();
  assert(local.some((m) => m.id === "alias")); assert(local.some((m) => m.id === "ollama-cache/simulated-model:7b"));
  assert.equal(local.find((m) => /mtp-simulated/.test(m.id))?.role, "draft");
  const embeddedEntry = local.find((m) => /Qwen3.6.*MTP/.test(m.id))!;
  assert.equal(embeddedEntry.role, "target", "an MTP repository name must not hide a full target GGUF");
  assert.deepEqual(embeddedEntry.mtp, { mode: "embedded", layers: 1 });
  assert(!local.some((m) => /00010-of|mmproj/.test(m.id)));
  assert.equal(await catalog.resolve("ollama-cache/simulated-model:7b"), path.join(process.env.OLLAMA_MODELS!, "blobs", `sha256-${digest}`));
  assert.equal((await catalog.getDetails("alias")).contextMemory?.variableKvBytesPerToken, 131072);
  await assert.rejects(catalog.getDetails("missing-file.gguf"), /Local GGUF not found/);
  console.log("ok bounded GGUF metadata / shard and projector filtering / read-only Ollama cache reuse");

  const simulator = new LlamaSimulator(), runtime = simulator.runtime(), provider = new LlamaProvider(runtime);
  const start = await Promise.all([provider.loadModel({ model: "simulated-7B", numCtx: 8192 }), provider.loadModel({ model: "simulated-7B", numCtx: 8192 })]);
  assert.equal(simulator.spawns.length, 1); assert.equal(start[0]!.sizeVramBytes, 432 * MIB);
  assert.equal(start[0]!.memoryKnown, true);
  const argv = simulator.spawns[0]!.args;
  for (const required of ["--offline", "--no-context-shift", "--no-warmup", "--no-agent"]) assert(argv.includes(required));
  assert.equal(argv[argv.indexOf("--model") + 1], modelFile);
  assert(!argv.includes("--hf-repo")); assert(simulator.spawns[0]!.env.LLAMA_API_KEY);
  assert(!(await provider.listModels()).some((model) => model.id === runtime.apiModel), "the private API alias must not appear as a selectable GGUF");
  assert(!(await provider.listModels()).some((model) => model.role === "draft"), "MTP sidecars must not appear as target models");
  assert((await provider.listDraftModels()).some((model) => model.role === "draft"), "MTP sidecars remain discoverable by inference setup");
  simulator.ready = false;
  assert.equal(await runtime.getRunningModel("simulated-7B"), null);
  simulator.ready = true;
  assert.equal((await runtime.getRunningModel("simulated-7B"))?.sizeVramBytes, 432 * MIB, "a transient health failure must not forget the owned allocation");
  const messages = Array.from({ length: 35 }, (_, index) => ({ role: "user" as const, content: `history ${index} Привет` }));
  const events: ChatStreamEvent[] = [];
  for await (const event of provider.chat({ model: "simulated-7B", messages, think: false, options: { num_ctx: 8192, num_predict: 2048, temperature: .2, top_p: .9, num_gpu: 999 } })) events.push(event);
  assert.equal(events.find((event) => event.type === "text")?.text, "Привет!");
  assert(events.some((event) => event.type === "reasoning" && event.text === "Проверю."));
  assert(events.some((event) => event.type === "done" && event.usage.tokensPerSecond === 30 && event.outputLimit === 2048));
  assert.deepEqual(simulator.requests[0]!.messages, messages);
  assert.equal(simulator.requests[0]!.reasoning_effort, "none");
  assert.equal((simulator.requests[0]!.chat_template_kwargs as Record<string, unknown>).enable_reasoning, false);
  assert(!("num_ctx" in simulator.requests[0]!) && !("num_gpu" in simulator.requests[0]!));
  assert.equal(simulator.spawns.length, 1, "chat must not silently reload a matching runner");
  simulator.tokenCount = 9000;
  await assert.rejects(async () => { for await (const _ of provider.chat({ model: "simulated-7B", messages, options: { num_ctx: 8192, num_predict: 2048 } })) {} }, /Full history requires/);
  assert.equal(simulator.requests.length, 1, "oversized actual token count must not reach generation");
  simulator.tokenCount = 12;
  const before = await runtime.memoryStatus(); const previous = await provider.unloadModel("simulated-7B");
  await runtime.waitForMemoryRelease(before, previous!.sizeVramBytes);
  await provider.loadModel({ model: "simulated-7B", numCtx: 32768 });
  assert.equal(simulator.spawns.length, 2);
  assert(simulator.events.indexOf("memory-free") < simulator.events.indexOf("spawn:32768"));

  const draftFile = path.join(root, "mtp-gemma-simulated-Q8_0.gguf");
  await writeFile(draftFile, sidecarBytes);
  const mtp = (profile: "mtp-3" | "mtp-6", draftMax: number) => ({
    profile, speculativeType: "draft-mtp" as const, draftModel: draftFile,
    draftDevice: "auto" as const, draftMax, draftCacheTypeK: "q8_0", draftCacheTypeV: "q8_0",
  });
  await provider.loadModel({ model: "simulated-7B", numCtx: 32768, inference: mtp("mtp-3", 3) });
  const mtpArgs = simulator.spawns.at(-1)!.args;
  assert.equal(mtpArgs[mtpArgs.indexOf("--spec-type") + 1], "draft-mtp");
  assert.equal(mtpArgs[mtpArgs.indexOf("--spec-draft-model") + 1], draftFile);
  assert.equal(mtpArgs[mtpArgs.indexOf("--spec-draft-n-max") + 1], "3");
  assert.equal(mtpArgs[mtpArgs.indexOf("--spec-draft-type-k") + 1], "q8_0");
  const sameMtpSpawns = simulator.spawns.length;
  await provider.loadModel({ model: "simulated-7B", numCtx: 32768, inference: mtp("mtp-3", 3) });
  assert.equal(simulator.spawns.length, sameMtpSpawns, "an unchanged inference profile reuses the runner");
  await provider.loadModel({ model: "simulated-7B", numCtx: 32768, inference: mtp("mtp-6", 6) });
  assert.equal(simulator.spawns.length, sameMtpSpawns + 1, "changing MTP depth restarts the managed runner once");
  assert.equal(simulator.spawns.at(-1)!.args[simulator.spawns.at(-1)!.args.indexOf("--spec-draft-n-max") + 1], "6");
  await provider.loadModel({ model: "simulated-7B", numCtx: 32768, inference: {
    profile: "ngram", speculativeType: "ngram-mod", draftDevice: "auto", draftMax: 0,
    draftCacheTypeK: "q8_0", draftCacheTypeV: "q8_0",
  } });
  assert.equal(simulator.spawns.at(-1)!.args[simulator.spawns.at(-1)!.args.indexOf("--spec-type") + 1], "ngram-mod");
  assert(!simulator.spawns.at(-1)!.args.includes("--spec-draft-model"));
  for (const depth of [2, 4, 5, 6, 8]) {
    await provider.loadModel({ model: embeddedFile, numCtx: 32768, inference: {
      ...mtp("mtp-3", depth), mtpMode: "embedded", draftModel: undefined,
    } });
    const args = simulator.spawns.at(-1)!.args;
    assert.equal(args[args.indexOf("--spec-draft-n-max") + 1], String(depth));
    assert(!args.includes("--spec-draft-model"), "embedded MTP uses the same loaded GGUF");
    assert(!args.includes("--spec-draft-device"), "embedded MTP follows target placement");
  }
  const embeddedSpawnCount = simulator.spawns.length;
  await provider.loadModel({ model: embeddedFile, numCtx: 32768, inference: { ...mtp("mtp-3", 8), mtpMode: "embedded", draftModel: undefined } });
  assert.equal(simulator.spawns.length, embeddedSpawnCount, "unchanged embedded MTP reuses the runner");
  await assert.rejects(provider.loadModel({ model: modelFile, numCtx: 32768, inference: { ...mtp("mtp-3", 2), mtpMode: "embedded", draftModel: undefined } }), /no embedded MTP head/);
  assert.equal(simulator.child!.killed, false, "invalid replacement metadata must not release a working runner");

  const rawConfig = defaultConfig();
  rawConfig.model = embeddedFile;
  rawConfig.llama.speculativeType = "draft-mtp";
  rawConfig.llama.speculativeMtpMode = "embedded";
  rawConfig.llama.speculativeDraftMax = 5;
  rawConfig.generation.numCtx = 32768;
  const rawChat = new ChatService({ config: rawConfig, provider, bus: new Bus(), store: new SessionStore(path.join(root, "raw-depth-sessions")), cwd: root });
  await rawChat.initialize();
  await rawChat.loadCurrentModel();
  assert.equal(simulator.spawns.at(-1)!.args[simulator.spawns.at(-1)!.args.indexOf("--spec-draft-n-max") + 1], "5", "low-level benchmark depth is never rounded to a TUI preset");
  assert.equal((await rawChat.inferenceSupport()).mode, "embedded");
  await rawChat.setInferenceProfile("mtp-2");
  await rawChat.loadCurrentModel();
  assert.equal(rawChat.loadedRunnerInfo?.inferenceMtpMode, "embedded");
  assert.equal(rawChat.loadedRunnerInfo?.inferenceDraftMax, 2);
  const qwenSession = rawChat.current!.meta.id;
  await assert.rejects(rawChat.setInferenceProfile("mtp-3", draftFile), /already contains MTP weights/);
  const qwenTui = new TinyCodeTui({ chat: rawChat, config: rawConfig, persistedConfig: structuredClone(rawConfig), configPath: path.join(root, "home/config.json"), bus: new Bus(), cwd: root, runtime });
  const qwenUi = qwenTui as unknown as {
    picker: Picker | null;
    pickerKind: string | null;
    scheduleRender(): void;
    openInferencePicker(): Promise<void>;
    applyPickerSelection(kind: string, item: { value: string; label: string }): Promise<void>;
    runCommand(text: string): Promise<void>;
  };
  qwenUi.scheduleRender = () => {};
  await qwenUi.openInferencePicker();
  assert(qwenUi.picker!.items.filter((item) => item.value.startsWith("mtp-")).every((item) => !item.disabled && item.detail?.includes("embedded")));
  qwenUi.picker = null; qwenUi.pickerKind = null;
  await qwenUi.applyPickerSelection("inference", { value: "mtp-3", label: "MTP 3x" });
  assert.equal(rawChat.currentInferenceProfile, "mtp-3");
  assert.equal(qwenUi.pickerKind, null, "Qwen MTP selection must not ask for a sidecar");
  await qwenUi.runCommand("/inference mtp-2");
  assert.equal(rawChat.currentInferenceProfile, "mtp-2");
  const savedQwen = mergeConfig(JSON.parse(await readFile(path.join(root, "home/config.json"), "utf8")));
  assert.deepEqual(savedQwen.models[rawChat.modelPreferenceKey]!.inference, { profile: "mtp-2" });
  await rawChat.createSession({ model: "simulated-7B" });
  await assert.rejects(rawChat.setInferenceProfile("mtp-2"), /embedded head.*Gemma sidecar/);
  await rawChat.resume(qwenSession);
  assert.equal(rawChat.currentInferenceProfile, "mtp-2", "embedded MTP profile survives session resume");
  assert.equal(rawChat.currentInferenceDraftModel, null);
  const spawnsBeforeInvalidMode = simulator.spawns.length;
  await assert.rejects(provider.loadModel({ model: embeddedFile, numCtx: 32768, inference: { ...mtp("mtp-3", 3), mtpMode: "sidecar" } }), /already contains an MTP head/);
  runtime.config.parallel = 2;
  await assert.rejects(provider.loadModel({ model: embeddedFile, numCtx: 32768, inference: { ...mtp("mtp-3", 3), mtpMode: "embedded", draftModel: undefined } }), /parallel=1/);
  runtime.config.parallel = 1;
  assert.equal(simulator.spawns.length, spawnsBeforeInvalidMode, "invalid embedded MTP setup must not allocate a replacement");
  await runtime.dispose();
  assert.equal(simulator.child!.killed, true);
  console.log("ok direct GGUF argv / one-slot load / streamed Unicode + reasoning / actual token refusal / unload-VRAM-reload");

  const external = new LlamaSimulator(); external.ready = true;
  const externalRuntime = external.runtime();
  assert.equal((await externalRuntime.loadModel({ model: modelFile, numCtx: 8192 })).memoryKnown, false);
  await assert.rejects(externalRuntime.loadModel({ model: modelFile, numCtx: 8192, inference: {
    profile: "ngram", speculativeType: "ngram-mod", draftDevice: "auto", draftMax: 0,
    draftCacheTypeK: "q8_0", draftCacheTypeV: "q8_0",
  } }), /cannot reconfigure an external llama-server/i);
  await assert.rejects(externalRuntime.loadModel({ model: modelFile, numCtx: 32768 }), /external llama-server/);
  await assert.rejects(externalRuntime.unloadModel(modelFile), /does not own/);
  await assert.rejects(externalRuntime.restartServer(), /Only a TinyCode-owned/);
  await externalRuntime.dispose(); assert(external.ready); assert.equal(external.spawns.length, 0);
  const capacity = calculateContextCapacity({ details: await catalog.getDetails("alias"), running: await externalRuntime.getRunningModel(modelFile), hardware: external.memory(), requestedContext: 8192 });
  assert.equal(capacity.placement, "unknown"); assert.equal(capacity.memoryKnown, true); assert(capacity.maximum > 8192); assert.equal(capacity.vramMaximum, null);
  const cancelled = new LlamaSimulator(); cancelled.blocked = true;
  const cancelRuntime = cancelled.runtime(), controller = new AbortController();
  cancelled.onWait = () => controller.abort(new Error("cancelled test"));
  await assert.rejects(cancelRuntime.loadModel({ model: "simulated-7B", numCtx: 8192, signal: controller.signal }), /cancelled test/);
  assert(cancelled.child!.killed); assert.equal(cancelled.spawns.length, 1);
  console.log("ok external-server reuse and ownership refusal / unknown placement / cancellation stops exact child");

  const nativeSimulator = new LlamaSimulator(), nativeRuntime = nativeSimulator.runtime(), nativeProvider = new LlamaProvider(nativeRuntime);
  let phase = 0;
  const native = (name: string, args: Record<string, unknown>) => [
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name, arguments: JSON.stringify(args).slice(0, 8) } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args).slice(8) } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 12, completion_tokens: 30, total_tokens: 42 } },
  ];
  nativeSimulator.response = () => phase++ === 0 ? native("create_file", { path: "created.html", content: "<html>Привет!</html>\n" })
    : phase === 2 ? native("read_file", { path: "created.html" })
      : [{ choices: [{ delta: { content: "Created created.html and checked its contents." }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 10, total_tokens: 22 } }];
  const nativeConfig = defaultConfig(); nativeConfig.model = "simulated-7B"; nativeConfig.tools.profile = "full"; nativeConfig.tools.profileByModel = false;
  const nativeTools = createDefaultTools();
  const nativeChat = new ChatService({ config: nativeConfig, provider: nativeProvider, bus: new Bus(), tools: nativeTools, store: new SessionStore(path.join(root, "native-sessions")), cwd: root, systemPrompt: "Test agent" });
  await nativeChat.initialize(); await nativeChat.send("Create created.html with a greeting.");
  assert.equal(await readFile(path.join(root, "created.html"), "utf8"), "<html>Привет!</html>\n");
  assert.equal(nativeChat.current!.messages.at(-1)!.outcome, "completed", nativeChat.current!.messages.at(-1)!.error);
  assert.equal(nativeChat.current!.meta.provider, "llama.cpp");
  nativeTools.dispose(); await nativeRuntime.dispose();
  assert.deepEqual(nativeSimulator.templates[0]!.tools, nativeSimulator.requests[0]!.tools, "actual token preflight includes the same native tools as generation");
  console.log("ok native tool delta bridge -> existing parser/guards -> complete file -> read-back verification");

  const xmlSimulator = new LlamaSimulator(), xmlRuntime = xmlSimulator.runtime();
  let xmlPhase = 0;
  const xmlContent = 'export const text = "</tool_call>";\n// <|tool_call>call:read_file{path:"literal"}<tool_call|>\n';
  const xmlCall = (name: string, args: Record<string, string>) => `<tool_call>\n<function=${name}>\n${Object.entries(args).map(([key, value]) => `<parameter=${key}>\n${value}\n</parameter>`).join("\n")}\n</function>\n</tool_call>`;
  xmlSimulator.response = () => [{ choices: [{ delta: { content: xmlPhase++ === 0
    ? xmlCall("create_file", { path: "qwen-created.ts", content: xmlContent })
    : xmlPhase === 2 ? xmlCall("read_file", { path: "qwen-created.ts" })
      : "Created qwen-created.ts and read its contents." }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 40, total_tokens: 52 } }];
  const xmlTools = createDefaultTools();
  const xmlChat = new ChatService({ config: structuredClone(nativeConfig), provider: new LlamaProvider(xmlRuntime), tools: xmlTools, bus: new Bus(), store: new SessionStore(path.join(root, "xml-sessions")), cwd: root, systemPrompt: "Test agent" });
  await xmlChat.initialize();
  await xmlChat.send("Create qwen-created.ts with the requested literal content.");
  assert.equal(await readFile(path.join(root, "qwen-created.ts"), "utf8"), xmlContent);
  assert.equal(xmlChat.current!.messages.at(-1)!.outcome, "completed", xmlChat.current!.messages.at(-1)!.error);
  xmlTools.dispose(); await xmlRuntime.dispose();
  console.log("ok Qwen XML tool-call fallback / schema arguments / literal file bytes / same approval and completion guards");

  const brokenStream = new LlamaSimulator(); brokenStream.endMarker = false;
  brokenStream.response = () => native("create_file", { path: "broken-stream.html", content: "Not to be written" });
  const brokenRuntime = brokenStream.runtime(), brokenTools = createDefaultTools();
  const brokenChat = new ChatService({ config: structuredClone(nativeConfig), provider: new LlamaProvider(brokenRuntime), bus: new Bus(), tools: brokenTools, store: new SessionStore(path.join(root, "broken-stream-sessions")), cwd: root, systemPrompt: "Test agent" });
  await brokenChat.initialize(); await brokenChat.send("Create broken-stream.html");
  await assert.rejects(access(path.join(root, "broken-stream.html")), { code: "ENOENT" });
  assert.match(brokenChat.current!.messages.at(-1)!.error!, /\[DONE\]/);
  brokenTools.dispose(); await brokenRuntime.dispose();
  console.log("ok disconnected SSE with native tool finish_reason still refuses execution without [DONE]");

  const truncatedSimulator = new LlamaSimulator(), truncatedRuntime = truncatedSimulator.runtime();
  truncatedSimulator.response = (body) => [{ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "create_file", arguments: '{"path":"unwritten.html","content":"unfinished' } }] }, finish_reason: "length" }], usage: { prompt_tokens: 12, completion_tokens: body.max_tokens } }];
  const truncatedConfig = structuredClone(nativeConfig); truncatedConfig.generation.numCtx = 65536;
  const truncatedTools = createDefaultTools();
  const truncatedChat = new ChatService({ config: truncatedConfig, provider: new LlamaProvider(truncatedRuntime), bus: new Bus(), tools: truncatedTools, store: new SessionStore(path.join(root, "truncated-sessions")), cwd: root, systemPrompt: "Test agent" });
  await truncatedChat.initialize(); await truncatedChat.send("Create unwritten.html with a page.");
  assert.deepEqual(truncatedSimulator.requests.map((request) => request.max_tokens), [2048, 4096, 8192, 8192]);
  await assert.rejects(access(path.join(root, "unwritten.html")), { code: "ENOENT" });
  assert.match(truncatedChat.current!.messages.at(-1)!.error!, /repeatedly exceeded/);
  truncatedTools.dispose(); await truncatedRuntime.dispose();
  console.log("ok truncated native tool payload / bounded output-budget repair / no partial file writes");

  const uiSimulator = new LlamaSimulator(), uiConfig = defaultConfig();
  uiConfig.model = "simulated-7B"; uiConfig.providerModels = { "llama.cpp": "simulated-7B", ollama: "simulated-ollama:7b" };
  const uiRuntime = uiSimulator.runtime(uiConfig.llama), uiProvider = new LlamaProvider(uiRuntime);
  const engines = new LocalEngines(uiConfig, new ProviderRegistry().register(uiProvider).register(new OllamaSimulator()), new Map([["llama.cpp", uiRuntime], ["ollama", inertRuntime]]));
  const store = new SessionStore(path.join(root, "ui-sessions")), bus = new Bus(), tools = createDefaultTools();
  const chat = new ChatService({ config: uiConfig, provider: engines, store, bus, tools, cwd: root, systemPrompt: "Test agent" });
  await chat.initialize();
  assert.equal(uiSimulator.spawns.length, 0); assert.equal(uiSimulator.installs, 0);
  const tui = new TinyCodeTui({ chat, config: uiConfig, persistedConfig: structuredClone(uiConfig), configPath: path.join(root, "home/config.json"), bus, cwd: root, runtime: engines });
  const ui = tui as unknown as {
    terminal: unknown; picker: Picker; pickerKind: string; scheduleRender(): void;
    openContextPicker(...args: unknown[]): Promise<void>; applyPickerSelection(kind: string, item: { value: string; label: string }): Promise<void>;
    runCommand(text: string): Promise<void>; preparePromptContext(signal: AbortSignal): Promise<void>;
    editor: { setText(text: string): void; text: string }; submit(): void; handleCtrlC(): void;
    handlePickerKey(key: Key): void;
  };
  ui.scheduleRender = () => {};
  await ui.runCommand("/models"); assert.equal(ui.pickerKind, "model");
  assert.deepEqual(ui.picker.items.filter((item) => item.heading).map((item) => item.label), ["Ollama", "llama.cpp"]);
  assert(!ui.picker.items.some((item) => /Change engine/i.test(item.label)));
  const open = ui.openContextPicker.bind(tui); let chosen!: () => void;
  const pickerReady = new Promise<void>((resolve) => { chosen = resolve; });
  ui.openContextPicker = async (...args) => { await open(...args); chosen(); };
  const firstPrompt = chat.send("Привет", (signal) => ui.preparePromptContext(signal));
  await pickerReady;
  assert.equal(chat.current!.messages.length, 1); assert.equal(textOf(chat.current!.messages[0]!), "Привет");
  assert.equal(uiSimulator.requests.length, 0); assert.equal(uiSimulator.spawns.length, 1);
  assert.match(ui.picker.options.title, /llama.cpp context/);
  await ui.applyPickerSelection("context", { value: "8192", label: "8,192 tokens" }); await firstPrompt;
  assert.equal(uiSimulator.spawns.length, 1); assert.equal(uiSimulator.requests.length, 1);
  await ui.runCommand("/context");
  await ui.applyPickerSelection("context", { value: "32768", label: "32,768 tokens" });
  assert.equal(uiSimulator.spawns.length, 2); assert.equal(chat.loadedRunnerContext, 32768);
  await chat.send("Привет ещё раз", (signal) => ui.preparePromptContext(signal));
  assert.equal(uiSimulator.spawns.length, 2, "warm changed context is reused by generation");
  const llamaSession = chat.current!.meta.id;
  await ui.applyPickerSelection("provider", { value: "ollama", label: "Ollama" });
  assert.equal(chat.currentProvider, "ollama"); assert.equal(chat.currentModel, "simulated-ollama:7b");
  assert.equal(uiSimulator.child!.killed, true);
  assert.equal(JSON.parse(await readFile(path.join(root, "home/config.json"), "utf8")).provider, "ollama");
  assert.equal((await store.load(llamaSession)).meta.provider, "ollama");
  await chat.createSession(); // Switch elsewhere so the saved session retains its last engine.
  await chat.setProvider("llama.cpp"); assert.equal(chat.currentModel, "simulated-7B");
  await chat.resume(llamaSession); assert.equal(chat.currentProvider, "ollama", "engine changes are persisted to the current session");
  const old = await store.create({ model: "simulated-ollama:7b", cwd: root });
  await chat.setProvider("llama.cpp"); await chat.resume(old.meta.id);
  assert.equal(chat.currentProvider, "ollama", "pre-provider session always resumes through Ollama");
  assert.equal(chat.current!.meta.provider, "ollama");
  tools.dispose(); await engines.dispose();
  console.log("ok /models engine picker / deferred welcome and first prompt / provider + runtime switch / old session routing");

  class AliasProvider extends OllamaSimulator {
    id = "llama.cpp";
    name = "llama.cpp";
    async getModelDetails(model: string): Promise<ModelDetails> { return { ...await super.getModelDetails(model), parameterSize: "26B A4B" }; }
  }
  let beginSwitch!: () => void, releaseSwitch!: () => void;
  const switchStarted = new Promise<void>((resolve) => { beginSwitch = resolve; });
  const switchGate = new Promise<void>((resolve) => { releaseSwitch = resolve; });
  const raceConfig = defaultConfig(); raceConfig.model = "local-alias";
  raceConfig.providerModels = { "llama.cpp": "local-alias", ollama: "simulated-ollama:7b" };
  const raceEngines = new LocalEngines(raceConfig, new ProviderRegistry().register(new AliasProvider()).register(new OllamaSimulator()), new Map([
    ["llama.cpp", { ...inertRuntime, dispose: async () => { beginSwitch(); await switchGate; } }], ["ollama", inertRuntime],
  ]));
  const raceStore = new SessionStore(path.join(root, "switch-race"));
  const raceChat = new ChatService({ config: raceConfig, provider: raceEngines, bus: new Bus(), store: raceStore, cwd: root });
  await raceChat.initialize(); assert.equal(raceChat.currentToolProfile, "full", "GGUF metadata supplies size for a local alias without 26B in its name");
  const switching = raceChat.setProvider("ollama");
  await switchStarted;
  assert(raceChat.busy);
  await assert.rejects(raceChat.send("Must wait"), /engine change|session\/engine change/);
  await assert.rejects(raceChat.resume(raceChat.current!.meta.id), /another engine\/session change/);
  await assert.rejects(raceChat.setModel("other"), /current generation/);
  assert.equal(raceChat.current!.messages.length, 0, "reject racing input before persistence");
  let idle = false;
  const waited = raceChat.waitForIdle().then(() => { idle = true; });
  await Promise.resolve(); assert.equal(idle, false);
  releaseSwitch(); await switching; await waited;
  assert.equal(raceChat.busy, false); assert.equal(raceChat.currentProvider, "ollama");
  assert.equal((await raceStore.load(raceChat.current!.meta.id)).meta.provider, "ollama");
  await raceEngines.dispose();
  console.log("ok asynchronous engine switch locks session/model/input / waitForIdle drains switch / size-based profile for aliases");

  const fromOllama = mergeConfig({ model: "simulated-ollama:7b", providerModels: { "llama.cpp": "local-alias" } });
  const oldOllama = new OllamaSimulator();
  oldOllama.running = { id: fromOllama.model, sizeBytes: GIB, sizeVramBytes: GIB, contextLength: 8192 };
  let waitedForOldRunner = false;
  const switchRuntime: LocalRuntime = {
    ...inertRuntime,
    memoryStatus: async () => simulator.memory(),
    waitForMemoryRelease: async (_before, released) => {
      assert.equal(released, GIB); assert.equal(oldOllama.running, null); waitedForOldRunner = true;
    },
  };
  const switchEngines = new LocalEngines(fromOllama, new ProviderRegistry().register(new AliasProvider()).register(oldOllama), new Map([
    ["ollama", switchRuntime], ["llama.cpp", inertRuntime],
  ]));
  await switchEngines.selectProvider("llama.cpp");
  assert.deepEqual(oldOllama.unloads, ["simulated-ollama:7b"]);
  assert(waitedForOldRunner); assert(oldOllama.otherModelAlive);
  assert.equal(switchEngines.id, "llama.cpp"); await switchEngines.dispose();
  console.log("ok Ollama -> llama.cpp expires selected runner and waits for VRAM / daemon and unrelated models untouched");

  async function contextFailureCase(name: string, failures: number) {
    const sim = new LlamaSimulator(); sim.startupFailures = failures;
    const config = defaultConfig(); config.model = "simulated-7B";
    const runtime = sim.runtime(config.llama), tools = createDefaultTools(), bus = new Bus();
    const chat = new ChatService({ config, provider: new LlamaProvider(runtime), tools, bus, store: new SessionStore(path.join(root, name)), cwd: root, systemPrompt: "Test agent" });
    await chat.initialize();
    const tui = new TinyCodeTui({ chat, config, persistedConfig: structuredClone(config), configPath: path.join(root, "home/config.json"), bus, cwd: root, runtime });
    const ui = tui as unknown as { scheduleRender(): void; preparePromptContext(signal: AbortSignal): Promise<void>; openContextPicker(...args: unknown[]): Promise<void>; applyPickerSelection(kind: string, item: { value: string; label: string }): Promise<void> };
    ui.scheduleRender = () => {};
    const original = ui.openContextPicker.bind(tui); let notify!: () => void;
    const shown = new Promise<void>((resolve) => { notify = resolve; });
    ui.openContextPicker = async (...args) => { await original(...args); notify(); };
    let restartCount = 0;
    const restart = runtime.restartServer.bind(runtime);
    runtime.restartServer = async (signal) => { restartCount++; await restart(signal); };
    const prompt = chat.send("Original prompt", (signal) => ui.preparePromptContext(signal));
    await shown;
    await ui.applyPickerSelection("context", { value: "32768", label: "32,768 tokens" });
    await prompt;
    assert.equal(restartCount, 1);
    assert.equal(sim.spawns.length, 3, "one fallback spawn after the selected context fails startup");
    assert.equal(textOf(chat.current!.messages[0]!), "Original prompt");
    assert.equal(sim.requests.length, 1, "the prompt completes at the 8k fallback");
    assert.equal(chat.contextLimit, 8192);
    assert.equal(sim.context, 8192);
    assert.equal(chat.current!.messages.at(-1)!.error, undefined);
    tools.dispose(); await runtime.dispose();
  }
  await contextFailureCase("recovered-llama-context", 1);
  await contextFailureCase("failed-llama-context", 9);
  console.log("ok llama.cpp startup OOM / one cleanup + 8k fallback / original prompt completes");

  const cliSimulator = new LlamaSimulator(); cliSimulator.ready = true;
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString("utf8");
      const value = await cliSimulator.fetch(`http://fake.invalid${request.url}`, body ? { method: request.method, body } : undefined);
      response.writeHead(value.status, Object.fromEntries(value.headers));
      response.end(Buffer.from(await value.arrayBuffer()));
    } catch (error) { response.writeHead(500); response.end(JSON.stringify({ error: String(error) })); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const cliHome = path.join(root, "cli-home"); await mkdir(cliHome);
  const cliConfig = defaultConfig(); cliConfig.model = modelFile;
  cliConfig.llama.baseUrl = `http://127.0.0.1:${port}`; cliConfig.llama.autoInstall = false;
  cliConfig.llama.modelDirs = [root]; cliConfig.ollama.autoStart = false;
  await writeFile(path.join(cliHome, "config.json"), JSON.stringify(cliConfig));
  const runCli = async (args: string[]) => {
    const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), path.resolve("src/cli.ts"), ...args], {
      cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: {
        ...process.env, TINYCODE_HOME: cliHome, TINYCODE_PROVIDER: "llama.cpp", TINYCODE_MODEL: "",
        TINYCODE_LLAMA_URL: cliConfig.llama.baseUrl, TINYCODE_LLAMA_EXECUTABLE: "",
      },
    });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (data: string) => { stdout += data; }); child.stderr.on("data", (data: string) => { stderr += data; });
    const timer = setTimeout(() => child.kill(), 20_000);
    try { const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); }); return { code, stdout, stderr }; }
    finally { clearTimeout(timer); }
  };
  try {
    const listed = await runCli(["models", "--provider", "llama.cpp", "--json"]);
    assert.equal(listed.code, 0, listed.stderr);
    assert(JSON.parse(listed.stdout).some((model: { id: string }) => model.id === modelFile));
    const answer = await runCli(["run", "--provider", "llama.cpp", "--model", modelFile, "Say hello"]);
    assert.equal(answer.code, 0, answer.stderr); assert.equal(answer.stdout.trim(), "Привет!");
    assert(cliSimulator.ready, "CLI must not stop an external server when it exits");
    const cliSessions = await new SessionStore(path.join(cliHome, "sessions")).list();
    assert.equal(cliSessions[0]!.provider, "llama.cpp");
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  console.log("ok real CLI --provider / model listing without installation / one-shot SSE / stdout discipline / external server survives exit");
  console.log("all local engine checks passed");
} finally {
  for (const [key, value] of Object.entries(environment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await rm(root, { recursive: true, force: true });
}
