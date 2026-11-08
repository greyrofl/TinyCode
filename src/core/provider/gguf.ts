import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { Config } from "../config/config.js";
import { parseModelDetails } from "./model-details.js";
import type { ModelDetails, ModelInfo } from "./types.js";
import { readJson } from "../../util/fs.js";
import { tinycodeHome } from "../../util/paths.js";
import { expandLocalPath } from "../runtime-process.js";

const VALUE_BYTES: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };

async function ggufMagic(file: string): Promise<boolean> {
  const handle = await open(file, "r").catch(() => null);
  if (!handle) return false;
  try { const bytes = Buffer.alloc(4); await handle.read(bytes, 0, 4, 0); return bytes.toString("ascii") === "GGUF"; }
  finally { await handle.close(); }
}

/** Read GGUF metadata only; tensor data and tokenizer arrays are skipped, not loaded. */
export async function readGgufMetadata(file: string): Promise<Record<string, unknown>> {
  const handle = await open(file, "r");
  const size = (await handle.stat()).size;
  let position = 0, buffer = Buffer.alloc(0), start = 0;
  async function bytes(length: number): Promise<Buffer> {
    if (!Number.isSafeInteger(length) || length < 0 || position + length > size || position + length > 256 * 1024 ** 2) throw new Error("Invalid or oversized GGUF metadata.");
    if (position < start || position + length > start + buffer.length) {
      start = position;
      buffer = Buffer.alloc(Math.min(size - position, Math.max(64 * 1024, length)));
      const count = await handle.read(buffer, 0, buffer.length, position);
      buffer = buffer.subarray(0, count.bytesRead);
    }
    const value = buffer.subarray(position - start, position - start + length);
    if (value.length !== length) throw new Error("Truncated GGUF metadata.");
    position += length;
    return value;
  }
  async function u64(): Promise<number> {
    const value = (await bytes(8)).readBigUInt64LE();
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("GGUF length is out of range.");
    return Number(value);
  }
  async function string(keep: boolean): Promise<string | undefined> {
    const length = await u64();
    if (length > 16 * 1024 ** 2 || position + length > size) throw new Error("Invalid GGUF string length.");
    if (keep) return (await bytes(length)).toString("utf8");
    position += length;
    return undefined;
  }
  async function value(type: number, keep: boolean, depth = 0): Promise<unknown> {
    if (depth > 4) throw new Error("Invalid nested GGUF metadata.");
    if (type === 8) return string(keep);
    if (type === 9) {
      const itemType = (await bytes(4)).readUInt32LE();
      const count = await u64();
      if (count > 2_000_000) throw new Error("GGUF array is too large.");
      if (VALUE_BYTES[itemType] && !keep) { position += count * VALUE_BYTES[itemType]!; if (position > size) throw new Error("Truncated GGUF array."); return undefined; }
      const result: unknown[] = [];
      for (let i = 0; i < count; i++) { const entry = await value(itemType, keep && count <= 512, depth + 1); if (keep && count <= 512) result.push(entry); }
      return keep && count <= 512 ? result : undefined;
    }
    const length = VALUE_BYTES[type];
    if (!length) throw new Error(`Unsupported GGUF value type ${type}.`);
    const data = await bytes(length);
    if (!keep) return undefined;
    switch (type) {
      case 0: return data.readUInt8(); case 1: return data.readInt8();
      case 2: return data.readUInt16LE(); case 3: return data.readInt16LE();
      case 4: return data.readUInt32LE(); case 5: return data.readInt32LE();
      case 6: return data.readFloatLE(); case 7: return data[0] !== 0;
      case 10: return Number(data.readBigUInt64LE()); case 11: return Number(data.readBigInt64LE());
      case 12: return data.readDoubleLE();
    }
  }
  try {
    if ((await bytes(4)).toString("ascii") !== "GGUF") throw new Error(`Not a GGUF model: ${path.basename(file)}`);
    const version = (await bytes(4)).readUInt32LE();
    if (version !== 2 && version !== 3) throw new Error(`Unsupported GGUF version ${version}.`);
    await u64(); // Tensor count. Tensor headers and weights are deliberately never read.
    const count = await u64();
    if (count > 100_000) throw new Error("Too many GGUF metadata entries.");
    const metadata: Record<string, unknown> = {};
    for (let i = 0; i < count; i++) {
      const key = (await string(true))!;
      const type = (await bytes(4)).readUInt32LE();
      const keep = key.startsWith("general.") || key === "tokenizer.chat_template" || /\.(nextn_predict_layers|context_length|block_count|embedding_length|expert_count|expert_used_count|attention\.(head_count|head_count_kv|key_length|value_length|key_length_swa|value_length_swa|sliding_window))$/.test(key);
      const entry = await value(type, keep);
      if (keep && entry !== undefined) metadata[key] = entry;
    }
    return metadata;
  } finally { await handle.close(); }
}

export function ggufModelDetails(id: string, metadata: Record<string, unknown>, sizeBytes: number): ModelDetails {
  const template = String(metadata["tokenizer.chat_template"] ?? "");
  const details = parseModelDetails(id, { model_info: metadata, details: {
    parameter_size: metadata["general.size_label"] ?? /(?:^|[-_ ])(\d+(?:\.\d+)?)[Bb](?=[-_ .]|$)/.exec(path.basename(id))?.[1]?.concat("B"),
  } });
  details.name = typeof metadata["general.name"] === "string" ? metadata["general.name"] : path.basename(id);
  details.sizeBytes = sizeBytes;
  const nextn = metadata[`${details.family}.nextn_predict_layers`];
  if (typeof nextn === "number" && Number.isInteger(nextn) && nextn > 0) details.mtp = { mode: "embedded", layers: nextn };
  else if (details.family === "gemma4-assistant") details.mtp = { mode: "sidecar" };
  details.role = details.mtp?.mode === "sidecar" ? "draft" : "target";
  details.quantization = /(?:UD-)?(?:I?Q\d(?:_[A-Z0-9]+)*|BF16|F16|F32)/i.exec(path.basename(id))?.[0]?.toUpperCase();
  const toggle = /enable_thinking|enable_reasoning/.test(template);
  const thinking = toggle || /<think>|<\|channel\|>|reasoning_effort/.test(template);
  details.thinking = {
    modes: toggle ? ["off", "on"] : thinking ? ["auto"] : ["off"],
    defaultMode: toggle ? "off" : thinking ? "auto" : "off",
    control: thinking ? "native" : "none",
    note: thinking && !toggle ? "The GGUF template advertises reasoning but no boolean switch. Supported levels are discovered after loading." : undefined,
  };
  return details;
}

export class GgufCatalog {
  private readonly entries = new Map<string, string>();
  private readonly details = new Map<string, ModelDetails>();
  constructor(private readonly config: Config["llama"], private readonly cwd: string, private readonly ollamaRoot?: string) {}

  async list(signal?: AbortSignal): Promise<ModelInfo[]> {
    this.entries.clear();
    for (const [name, file] of Object.entries(this.config.models)) this.entries.set(name, expandLocalPath(file, this.cwd));
    const directories = [...new Set([
      path.join(tinycodeHome(), "models"), path.join(this.cwd, "models"),
      ...(process.env.LLAMA_CACHE ? [process.env.LLAMA_CACHE] : [path.join(os.homedir(), ".cache", "llama.cpp")]),
      ...this.config.modelDirs.map((dir) => expandLocalPath(dir, this.cwd)),
    ])];
    let visited = 0;
    const scan = async (dir: string, depth = 0): Promise<void> => {
      if (depth > 4 || visited > 4096) return;
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        signal?.throwIfAborted();
        if (++visited > 4096) break;
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) await scan(file, depth + 1);
        else if (entry.isFile() && /\.gguf$/i.test(entry.name) && !/^mmproj/i.test(entry.name)) {
          const shard = /-(\d+)-of-\d+\.gguf$/i.exec(entry.name);
          if (!shard || Number(shard[1]) === 1) this.entries.set(file, file);
        }
      }
    };
    for (const dir of directories) await scan(dir);
    // Ollama's model layer is already a GGUF; reuse it read-only, never copy it.
    const root = this.ollamaRoot ?? process.env.OLLAMA_MODELS ?? path.join(os.homedir(), ".ollama", "models");
    const manifests = path.join(root, "manifests");
    let count = 0;
    const readManifests = async (dir: string, depth = 0): Promise<void> => {
      if (depth > 5 || count > 2048) return;
      for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        signal?.throwIfAborted();
        if (++count > 2048) return;
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) await readManifests(file, depth + 1);
        else if (entry.isFile()) {
          const size = (await stat(file)).size;
          if (size > 1024 ** 2) continue;
          const manifest = await readJson<{ layers?: Array<{ mediaType?: string; digest?: string }> }>(file).catch(() => null);
          const digest = manifest?.layers?.find((layer) => layer.mediaType === "application/vnd.ollama.image.model")?.digest;
          if (!/^sha256:[a-f0-9]{64}$/.test(digest ?? "")) continue;
          const blob = path.join(root, "blobs", digest!.replace(":", "-"));
          const relative = path.relative(manifests, file).split(path.sep);
          const tag = relative.pop()!;
          relative.shift(); // Registry name.
          if (relative[0] === "library") relative.shift();
          this.entries.set(`ollama-cache/${relative.join("/")}:${tag}`, blob);
        }
      }
    };
    await readManifests(manifests);
    const result: ModelInfo[] = [];
    for (const [id, file] of this.entries) {
      signal?.throwIfAborted();
      const info = await stat(file).catch(() => null);
      if (!info?.isFile() || !await ggufMagic(file)) continue;
      const name = id.startsWith("ollama-cache/") ? id : path.basename(id);
      // Read suspicious entries to distinguish full MTP-enabled targets from
      // standalone sidecars. A folder/repository named "MTP" is not a role.
      const suspicious = /(?:^|[-_. /\\])(?:mtp|draft)(?:[-_. /\\]|$)/i.test(`${id} ${name} ${path.basename(file)}`);
      const details = suspicious ? await this.getDetails(id).catch(() => null) : null;
      const role = details?.role ?? "target";
      result.push({ id, name, sizeBytes: info.size, modifiedAt: info.mtime.toISOString(), role, ...(details?.mtp ? { mtp: details.mtp } : {}) });
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }

  async resolve(model: string): Promise<string> {
    if (!model.trim()) throw new Error("Select a local GGUF with /models, or pass --model <path.gguf>. Model weights are not downloaded automatically.");
    if (this.config.models[model]) return expandLocalPath(this.config.models[model], this.cwd);
    if (!this.entries.has(model) && model.startsWith("ollama-cache/")) await this.list();
    return this.entries.get(model) ?? expandLocalPath(model, this.cwd);
  }

  async getDetails(model: string): Promise<ModelDetails> {
    const file = await this.resolve(model);
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) throw new Error(`Local GGUF not found: ${model}. Use /models or configure llama.modelDirs / llama.models.`);
    const key = `${model}:${info.size}:${info.mtimeMs}`;
    let details = this.details.get(key);
    if (!details) { details = ggufModelDetails(model, await readGgufMetadata(file), info.size); this.details.set(key, details); }
    return details;
  }
}
