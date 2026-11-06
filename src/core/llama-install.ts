import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, open, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config/config.js";
import { readJson, writeJsonAtomic } from "../util/fs.js";
import { tinycodeHome } from "../util/paths.js";
import { captureProcess, expandLocalPath, findExecutable } from "./runtime-process.js";

const REPOSITORY = "https://api.github.com/repos/ggml-org/llama.cpp";
const MAX_ASSET_BYTES = 1024 ** 3;

export interface LlamaReleaseAsset {
  name: string;
  size: number;
  digest?: string;
  browser_download_url: string;
}
interface Release { tag_name: string; assets: LlamaReleaseAsset[] }
interface Installation { executable: string; tag: string; requestedRelease?: string; backend: string; platform?: string; arch?: string }
export interface LlamaInstallDependencies {
  fetch?: typeof fetch;
  platform?: NodeJS.Platform;
  arch?: string;
  findExecutable?: (name: string) => Promise<string | null>;
  capture?: typeof captureProcess;
  extract?: (archive: string, destination: string, signal?: AbortSignal) => Promise<void>;
  notice?: (text: string) => void;
  root?: string;
}

/** Select actual release assets rather than guessing download URLs. CUDA needs its matching runtime archive. */
export function selectLlamaAssets(assets: LlamaReleaseAsset[], platform: string, arch: string, backend: string): LlamaReleaseAsset[] {
  const machine = arch === "x64" ? "x64" : arch === "arm64" ? "arm64" : "";
  if (!machine || !["win32", "linux", "darwin"].includes(platform)) throw new Error(`Automatic llama.cpp installation is unavailable for ${platform}/${arch}. Set llama.executable to a built llama-server.`);
  const osName = platform === "win32" ? "win" : platform === "darwin" ? "macos" : "ubuntu";
  const suffix = platform === "win32" ? ".zip" : ".tar.gz";
  if (platform === "darwin" && !["cpu", "metal"].includes(backend)) throw new Error(`The official macOS binary does not provide the ${backend} backend. Use Metal/CPU or configure a custom executable.`);
  let match: LlamaReleaseAsset | undefined;
  if (backend === "cuda") {
    // Prefer the broadest driver-compatible build, not the newest CUDA toolchain.
    const version = platform === "win32" && machine === "x64" ? "12.4" : "12.8";
    match = assets.find((asset) => asset.name.startsWith("llama-") && asset.name.endsWith(`-bin-${osName}-cuda-${version}-${machine}${suffix}`));
  } else {
    if (backend === "metal" && platform !== "darwin") throw new Error("The Metal backend requires macOS.");
    const flavor = platform === "darwin" ? "" : backend === "vulkan" ? "-vulkan" : platform === "win32" ? "-cpu" : "";
    match = assets.find((asset) => asset.name.startsWith("llama-") && asset.name.endsWith(`-bin-${osName}${flavor}-${machine}${suffix}`));
  }
  if (!match) throw new Error(`This llama.cpp release has no ${platform}/${arch}/${backend} binary. Choose another release/backend or set llama.executable.`);
  const selected = [match];
  if (backend === "cuda") {
    const marker = match.name.slice(match.name.indexOf("-bin-") + 1);
    const runtime = assets.find((asset) => asset.name.startsWith("cudart-") && asset.name.endsWith(marker));
    if (!runtime) throw new Error("The release is missing the matching CUDA runtime archive; installation was not attempted.");
    selected.push(runtime);
  }
  for (const asset of selected) {
    if (!/^sha256:[a-f0-9]{64}$/i.test(asset.digest ?? "") || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_ASSET_BYTES ||
      !asset.browser_download_url.startsWith("https://github.com/ggml-org/llama.cpp/releases/download/")) {
      throw new Error("The official asset has no valid SHA-256, size or download URL. Refusing to install an unverified engine.");
    }
  }
  return selected;
}

export function safeArchivePath(name: string): boolean {
  const normalized = name.replace(/\\/g, "/");
  return Boolean(normalized) && !normalized.startsWith("/") && !/^[a-z]:/i.test(normalized) &&
    !normalized.split("/").includes("..") && !normalized.includes("\0");
}

async function extractArchive(archive: string, destination: string, signal?: AbortSignal): Promise<void> {
  const entries = (await captureProcess("tar", ["-tf", archive], signal, 60_000)).split(/\r?\n/).filter(Boolean);
  if (entries.length > 20_000 || entries.some((entry) => !safeArchivePath(entry))) throw new Error("Unsafe path in llama.cpp archive.");
  // Validate link destinations before extraction, including Linux shared-library links.
  const verbose = await captureProcess("tar", ["-tvf", archive], signal, 60_000);
  for (const line of verbose.split(/\r?\n/)) {
    const symbolic = /\s(\S+) -> (.+)$/.exec(line);
    const hard = /\s(\S+) link to (.+)$/.exec(line);
    if (symbolic && (!safeArchivePath(symbolic[2]!) || !safeArchivePath(path.posix.join(path.posix.dirname(symbolic[1]!), symbolic[2]!)))) throw new Error("Unsafe symbolic link in engine archive.");
    if (hard && !safeArchivePath(hard[2]!)) throw new Error("Unsafe hard link in engine archive.");
    if (/^[bcp]/.test(line)) throw new Error("Special file in engine archive.");
  }
  await captureProcess("tar", ["-xf", archive, "-C", destination], signal, 120_000);
  const root = await realpath(destination);
  async function check(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      const resolved = await realpath(file);
      const relative = path.relative(root, resolved);
      if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Extracted engine file escaped its installation directory.");
      if (entry.isDirectory()) await check(file);
    }
  }
  await check(root);
}

async function executableIn(dir: string, name: string, depth = 0): Promise<string | null> {
  if (depth > 5) return null;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === name) return file;
    if (entry.isDirectory()) { const found = await executableIn(file, name, depth + 1); if (found) return found; }
  }
  return null;
}

/** Installs only official binaries in TinyCode state, never weights, PATH or OS-wide settings. */
export class LlamaInstaller {
  private pending: Promise<string> | null = null;
  constructor(private readonly config: Config["llama"], private readonly dependencies: LlamaInstallDependencies = {}) {}
  private get root(): string { return this.dependencies.root ?? path.join(tinycodeHome(), "engines", "llama.cpp"); }
  private get platform(): NodeJS.Platform { return this.dependencies.platform ?? process.platform; }
  private get arch(): string { return this.dependencies.arch ?? process.arch; }
  private get name(): string { return this.platform === "win32" ? "llama-server.exe" : "llama-server"; }

  async locate(): Promise<string | null> {
    const find = this.dependencies.findExecutable ?? findExecutable;
    if (this.config.executable) {
      const value = expandLocalPath(this.config.executable);
      const candidate = (await stat(value).catch(() => null))?.isDirectory() ? path.join(value, this.name) : this.config.executable;
      const executable = await find(candidate);
      if (!executable) throw new Error(`Configured llama.executable was not found: ${this.config.executable}`);
      return executable;
    }
    const system = await find(this.name);
    if (system) return system;
    const saved = await readJson<Installation>(path.join(this.root, "current.json")).catch(() => null);
    if (saved && typeof saved.executable === "string" && typeof saved.tag === "string" && typeof saved.backend === "string" &&
      (!saved.platform || saved.platform === this.platform) && (!saved.arch || saved.arch === this.arch) &&
      (this.config.release === "latest" || saved.tag === this.config.release || saved.requestedRelease === this.config.release) &&
      (this.config.backend === "auto" || saved.backend === this.config.backend)) {
      const file = path.resolve(this.root, saved.executable);
      if (safeArchivePath(saved.executable) && await stat(file).then((s) => s.isFile()).catch(() => false)) return file;
    }
    return null;
  }

  async ensure(signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    if (this.pending) return this.pending;
    const operation = this.install(signal);
    this.pending = operation;
    try { return await operation; } finally { this.pending = null; }
  }

  private async release(signal?: AbortSignal): Promise<Release> {
    const request = this.dependencies.fetch ?? fetch;
    const get = async (url: string): Promise<Release> => {
      const response = await request(url, { headers: { accept: "application/vnd.github+json", "user-agent": "TinyCode" }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`Cannot read official llama.cpp release (HTTP ${response.status}). Install llama-server manually or retry later.`);
      return await response.json() as Release;
    };
    const tag = this.config.release;
    if (tag !== "latest" && !/^[a-zA-Z0-9._-]+$/.test(tag)) throw new Error("Invalid llama.cpp release tag.");
    let release = await get(`${REPOSITORY}/releases/${tag === "latest" ? "latest" : `tags/${tag}`}`);
    if (!Array.isArray(release.assets)) throw new Error("Invalid official release metadata.");
    if (!release.assets.some((asset) => asset.name.startsWith("llama-"))) {
      const pointer = release.assets.find((asset) => asset.name === "nightly-tag.txt");
      if (!pointer || !pointer.browser_download_url.startsWith("https://github.com/ggml-org/llama.cpp/releases/download/") ||
        !Number.isSafeInteger(pointer.size) || pointer.size < 1 || pointer.size > 128 || !/^sha256:[a-f0-9]{64}$/i.test(pointer.digest ?? "")) {
        throw new Error("The stable release has no verified binary-build pointer.");
      }
      const response = await request(pointer.browser_download_url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error("Cannot resolve the stable llama.cpp binary build.");
      const pointerBytes = Buffer.from(await response.arrayBuffer());
      if (pointerBytes.length !== pointer.size || createHash("sha256").update(pointerBytes).digest("hex") !== pointer.digest!.slice(7).toLowerCase()) {
        throw new Error("The stable llama.cpp binary-build pointer failed SHA-256/size verification.");
      }
      const build = pointerBytes.toString("utf8").trim();
      if (!/^b\d+$/.test(build)) throw new Error("Invalid official binary-build tag.");
      release = await get(`${REPOSITORY}/releases/tags/${build}`);
    }
    if (!/^[a-zA-Z0-9._-]+$/.test(release.tag_name)) throw new Error("Invalid binary release tag.");
    return release;
  }

  private async chooseBackend(): Promise<string> {
    if (this.config.backend !== "auto") return this.config.backend;
    if (this.platform === "darwin") return "metal";
    try {
      const driver = await (this.dependencies.capture ?? captureProcess)("nvidia-smi", ["--query-gpu=driver_version", "--format=csv,noheader"], undefined, 5_000);
      if (Number.parseFloat(driver) >= (this.platform === "win32" ? 551.61 : 570)) return "cuda";
    } catch { /* No compatible NVIDIA driver: portable CPU build. */ }
    return "cpu";
  }

  private async download(asset: LlamaReleaseAsset, file: string, signal?: AbortSignal): Promise<void> {
    this.dependencies.notice?.(`Downloading llama.cpp: ${asset.name} (${Math.ceil(asset.size / 1024 ** 2)} MiB)…`);
    const timeout = AbortSignal.timeout(600_000);
    const response = await (this.dependencies.fetch ?? fetch)(asset.browser_download_url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!response.ok || !response.body) throw new Error(`Engine download failed (HTTP ${response.status}).`);
    const handle = await open(file, "wx");
    const hash = createHash("sha256");
    let count = 0;
    try {
      for await (const chunk of response.body) {
        signal?.throwIfAborted();
        count += chunk.byteLength;
        if (count > asset.size || count > MAX_ASSET_BYTES) throw new Error("Engine download exceeded its declared size.");
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.byteLength) offset += (await handle.write(chunk, offset, chunk.byteLength - offset)).bytesWritten;
      }
      if (count !== asset.size || hash.digest("hex") !== asset.digest!.slice(7).toLowerCase()) throw new Error("llama.cpp SHA-256/size verification failed. Nothing was installed.");
    } finally { await handle.close(); }
  }

  private async install(signal?: AbortSignal): Promise<string> {
    const requestedRelease = this.config.release;
    const existing = await this.locate();
    if (existing) return existing;
    if (!this.config.autoInstall) throw new Error("llama-server was not found. Set llama.executable or enable llama.autoInstall.");
    this.dependencies.notice?.("llama-server not found; preparing a verified local installation…");
    const [release, backend] = await Promise.all([this.release(signal), this.chooseBackend()]);
    const assets = selectLlamaAssets(release.assets, this.platform, this.arch, backend);
    await mkdir(this.root, { recursive: true });
    const staging = await mkdtemp(path.join(this.root, ".install-"));
    const content = path.join(staging, "content");
    await mkdir(content);
    try {
      for (const asset of assets) {
        const archive = path.join(staging, path.basename(asset.name));
        await this.download(asset, archive, signal);
        await (this.dependencies.extract ?? extractArchive)(archive, content, signal);
      }
      const binary = await executableIn(content, this.name);
      if (!binary) throw new Error("Official archive did not contain llama-server.");
      if (this.platform !== "win32") await chmod(binary, 0o755);
      await (this.dependencies.capture ?? captureProcess)(binary, ["--version"], signal, 15_000);
      signal?.throwIfAborted();
      const folder = `${release.tag_name}-${this.platform}-${this.arch}-${backend}`;
      const destination = path.join(this.root, folder);
      const relative = path.relative(content, binary);
      try { await rename(content, destination); }
      catch (error) {
        // Another TinyCode may have completed the same install; never overwrite it.
        if (!(await stat(path.join(destination, relative)).catch(() => null))?.isFile()) throw error;
      }
      const executable = path.join(destination, relative);
      signal?.throwIfAborted();
      await writeJsonAtomic(path.join(this.root, "current.json"), { executable: path.relative(this.root, executable), tag: release.tag_name, requestedRelease, backend, platform: this.platform, arch: this.arch });
      this.dependencies.notice?.(`llama.cpp ${release.tag_name} installed (${backend}); system PATH and model weights unchanged.`);
      return executable;
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
}
