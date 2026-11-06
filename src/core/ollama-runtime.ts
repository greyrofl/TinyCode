import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Config } from "./config/config.js";
import { readHardwareMemory, runtimeWait, type ParallelStatus, type HardwareMemoryStatus } from "./runtime.js";
export { runtimeWait } from "./runtime.js";
export type { ParallelStatus, HardwareMemoryStatus } from "./runtime.js";

export interface LocalServerProcess {
  pid: number;
  executable: string;
  commandLine: string;
  started: string;
  listenAddress?: string;
}

export function isOllamaServerProcess(info: LocalServerProcess): boolean {
  const executable = info.executable.split(/[\\/]/).at(-1)?.toLowerCase();
  return Number.isInteger(info.pid) && info.pid > 4 && Boolean(info.started) &&
    (executable === "ollama.exe" || executable === "ollama") && /(?:^|\s)"?serve"?(?=\s|$)/i.test(info.commandLine);
}

export interface RuntimeDependencies {
  fetch?: typeof fetch;
  spawnServer?: (env: NodeJS.ProcessEnv) => ChildProcess;
  persistParallel?: () => Promise<void>;
  memoryStatus?: () => Promise<HardwareMemoryStatus | null>;
  restartServer?: () => Promise<void>;
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export function isLocalOllamaUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname) &&
      !url.username && !url.password && url.pathname === "/";
  } catch {
    return false;
  }
}

async function powershell(script: string): Promise<string> {
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); ${script}`], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let error = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { output += chunk; });
  child.stderr.on("data", (chunk: string) => { error += chunk; });
  const timer = setTimeout(() => child.kill(), 10_000);
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => code === 0 ? resolve() : reject(new Error(error.trim() || "PowerShell failed.")));
    });
    return output.trim();
  } finally {
    clearTimeout(timer);
  }
}

async function capture(command: string, args: string[]): Promise<string> {
  const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let error = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { output += chunk; });
  child.stderr.on("data", (chunk: string) => { error += chunk; });
  const timer = setTimeout(() => child.kill(), 5_000);
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => code === 0 ? resolve() : reject(new Error(error.trim() || `${command} failed.`)));
    });
    return output.trim();
  } finally {
    clearTimeout(timer);
  }
}

async function stopOwnedProcess(child: ChildProcess, fake = false): Promise<void> {
  if (child.exitCode !== null || child.killed) return;
  if (fake || !child.pid) { child.kill(); return; }
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    await new Promise<void>((resolve, reject) => {
      killer.once("error", reject);
      killer.once("close", (code) => code === 0 || child.exitCode !== null ? resolve() : reject(new Error("Cannot stop the TinyCode-managed Ollama process tree.")));
    });
  } else {
    try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill(); }
  }
}

/** Automatic startup owns only its child. Explicit restart verifies the local listener. */
export class OllamaRuntime {
  private child: ChildProcess | null = null;
  private startError: Error | null = null;
  private starting: Promise<boolean> | null = null;
  private restarting: Promise<void> | null = null;
  private effectiveParallel: number | null = null;

  constructor(private readonly config: Config["ollama"], private readonly dependencies: RuntimeDependencies = {}) {}

  async available(): Promise<boolean> {
    try {
      const response = await (this.dependencies.fetch ?? fetch)(`${this.config.baseUrl.replace(/\/+$/, "")}/api/version`, {
        headers: this.config.headers,
        signal: AbortSignal.timeout(1_500),
      });
      if (!response.ok) return false;
      const value = await response.json() as { version?: unknown };
      return typeof value.version === "string";
    } catch {
      return false;
    }
  }

  /** Returns true only if this invocation started Ollama. */
  async ensureStarted(): Promise<boolean> {
    if (this.starting) return this.starting;
    const operation = this.start();
    this.starting = operation;
    try {
      return await operation;
    } finally {
      this.starting = null;
    }
  }

  private async start(explicit = false, overrides: NodeJS.ProcessEnv = {}, executable = "ollama"): Promise<boolean> {
    if (await this.available()) return false;
    if ((!this.config.autoStart && !explicit) || !isLocalOllamaUrl(this.config.baseUrl)) {
      throw new Error(`Ollama is unavailable at ${this.config.baseUrl}. Start the server with ollama serve.`);
    }
    this.startError = null;
    const env = {
      ...process.env,
      OLLAMA_HOST: new URL(this.config.baseUrl).host,
      ...(this.config.parallel !== null ? { OLLAMA_NUM_PARALLEL: String(this.config.parallel) } : {}),
      ...overrides,
    };
    const parallel = Number(env.OLLAMA_NUM_PARALLEL);
    this.effectiveParallel = Number.isInteger(parallel) && parallel > 0 ? parallel : null;
    this.child = this.dependencies.spawnServer ? this.dependencies.spawnServer(env) : spawn(executable, ["serve"], {
      // Windows detached processes allocate a separate console. Ignored stdio
      // and unref let the server outlive TinyCode without requesting one.
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: "ignore",
      env,
    });
    this.child.once("error", (error) => { this.startError = error; });
    this.child.unref();
    const deadline = Date.now() + this.config.startupTimeoutMs;
    while (Date.now() < deadline) {
      if (await this.available()) return true;
      const failure = this.startError as Error | null; // populated asynchronously by the child error event
      if (failure) {
        const code = (failure as NodeJS.ErrnoException).code;
        throw new Error(code === "ENOENT"
          ? "Ollama is not installed or is not on PATH. Install it from https://ollama.com."
          : `Cannot start Ollama: ${failure.message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await stopOwnedProcess(this.child, Boolean(this.dependencies.spawnServer));
    this.child = null;
    throw new Error(`Ollama did not become ready within ${this.config.startupTimeoutMs / 1_000}s.`);
  }

  async parallelStatus(): Promise<ParallelStatus> {
    const local = isLocalOllamaUrl(this.config.baseUrl);
    if (!local) return { value: null, source: "remote server; cannot inspect environment", local, canSet: false };
    if (this.child && this.child.exitCode === null && !this.child.killed && (this.config.parallel ?? this.effectiveParallel) !== null) {
      return { value: this.config.parallel ?? this.effectiveParallel, source: "TinyCode-managed server", local, canSet: true };
    }
    if (process.platform === "win32" && new URL(this.config.baseUrl).port === "11434") {
      try {
        const log = await readFile(path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "Ollama", "server.log"), "utf8");
        const value = [...log.matchAll(/OLLAMA_NUM_PARALLEL:(\d+)/g)].at(-1)?.[1];
        if (value) return { value: Number(value), source: "Ollama server startup log", local, canSet: true };
      } catch { /* Fall back to the local environment. */ }
    }
    const configured = Number(process.env.OLLAMA_NUM_PARALLEL);
    return {
      value: Number.isInteger(configured) && configured > 0 ? configured : null,
      source: "local environment (running server may differ)",
      local,
      canSet: true,
    };
  }

  async memoryStatus(): Promise<HardwareMemoryStatus | null> {
    if (this.dependencies.memoryStatus) return this.dependencies.memoryStatus();
    if (!isLocalOllamaUrl(this.config.baseUrl)) return null;
    return readHardwareMemory();
  }

  /** Wait for VRAM recovery, not merely an empty /api/ps response. */
  async waitForMemoryRelease(before: HardwareMemoryStatus | null, releasedVram: number, signal?: AbortSignal, minimumFree?: number): Promise<void> {
    const wait = this.dependencies.wait ?? runtimeWait;
    if (!before?.gpus.length || (releasedVram < 32 * 1024 ** 2 && minimumFree === undefined)) {
      await wait(750, signal);
      return;
    }
    const total = before.gpus.reduce((sum, gpu) => sum + gpu.totalBytes, 0);
    const free = before.gpus.reduce((sum, gpu) => sum + gpu.freeBytes, 0);
    const target = Math.min(total - 256 * 1024 ** 2, minimumFree ?? free + releasedVram * 0.75);
    const deadline = Date.now() + 30_000;
    while (true) {
      if (signal?.aborted) throw new Error("Runner memory release cancelled.");
      const current = await this.memoryStatus();
      if (!current?.gpus.length) {
        await wait(1000, signal);
        return;
      }
      if (current.gpus.reduce((sum, gpu) => sum + gpu.freeBytes, 0) >= target) return;
      if (Date.now() >= deadline) throw new Error("VRAM was not released after stopping the runner. The new model was not loaded.");
      await wait(250, signal);
    }
  }

  /** Explicit user-authorized fallback; never kill all processes by name. */
  async restartServer(signal?: AbortSignal): Promise<void> {
    if (!isLocalOllamaUrl(this.config.baseUrl)) throw new Error("A remote Ollama server must be restarted by its owner.");
    if (signal?.aborted) throw new Error("Ollama restart cancelled.");
    if (this.restarting) return this.restarting;
    const operation = this.restartLocalServer(signal);
    this.restarting = operation;
    try { await operation; }
    finally { this.restarting = null; }
  }

  private async restartLocalServer(signal?: AbortSignal): Promise<void> {
    if (this.dependencies.restartServer) return this.dependencies.restartServer();
    const parallel = await this.parallelStatus();
    let executable = "ollama";
    const overrides: NodeJS.ProcessEnv = {};
    if (process.platform === "win32") {
      try {
        // Read only known runner settings. Do not persist environment changes.
        const raw = await powershell("$e=@{};foreach($k in @('OLLAMA_NUM_PARALLEL','OLLAMA_KV_CACHE_TYPE','OLLAMA_FLASH_ATTENTION','OLLAMA_GPU_OVERHEAD','OLLAMA_CONTEXT_LENGTH','OLLAMA_MAX_LOADED_MODELS','OLLAMA_MODELS','CUDA_VISIBLE_DEVICES','OLLAMA_VULKAN')){$v=[Environment]::GetEnvironmentVariable($k,'User');if($null -ne $v){$e[$k]=$v}};$e|ConvertTo-Json -Compress");
        const env = JSON.parse(raw) as Record<string, unknown>;
        for (const [key, value] of Object.entries(env)) if (typeof value === "string") overrides[key] = value;
      } catch { /* Retain the current process environment. */ }
    }
    if (parallel.value !== null && overrides.OLLAMA_NUM_PARALLEL === undefined) {
      overrides.OLLAMA_NUM_PARALLEL = String(parallel.value);
    }
    if (this.config.parallel !== null) overrides.OLLAMA_NUM_PARALLEL = String(this.config.parallel);
    if (signal?.aborted) throw new Error("Ollama restart cancelled; nothing was stopped.");

    if (this.child && this.child.exitCode === null && !this.child.killed) {
      await stopOwnedProcess(this.child, Boolean(this.dependencies.spawnServer));
      this.child = null;
    } else {
      if (process.platform !== "win32") throw new Error("Cannot safely identify an unmanaged Ollama process on this platform. Restart it manually.");
      const port = Number(new URL(this.config.baseUrl).port || "80");
      const find = `$connections=@(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction Stop);$ids=@($connections|Select-Object -ExpandProperty OwningProcess -Unique);if($ids.Count -ne 1){throw 'The Ollama listener has no unique owner'};$p=Get-CimInstance Win32_Process -Filter \"ProcessId=$($ids[0])\";$address=($connections|Select-Object -First 1).LocalAddress;if($connections.LocalAddress -contains '0.0.0.0'){$address='0.0.0.0'};@{pid=[int]$p.ProcessId;executable=[string]$p.ExecutablePath;commandLine=[string]$p.CommandLine;started=$p.CreationDate.ToUniversalTime().ToString('o');listenAddress=$address}|ConvertTo-Json -Compress`;
      const owner = JSON.parse(await powershell(find)) as LocalServerProcess;
      if (!isOllamaServerProcess(owner)) throw new Error("The configured port is not owned by a verified ollama serve process. Nothing was stopped.");
      const current = JSON.parse(await powershell(find)) as LocalServerProcess;
      if (!isOllamaServerProcess(current) || current.pid !== owner.pid || current.started !== owner.started) {
        throw new Error("The Ollama listener changed during verification. Nothing was stopped.");
      }
      if (signal?.aborted) throw new Error("Ollama restart cancelled; nothing was stopped.");
      executable = owner.executable;
      if (owner.listenAddress) {
        overrides.OLLAMA_HOST = `${owner.listenAddress.includes(":") ? `[${owner.listenAddress}]` : owner.listenAddress}:${port}`;
      }
      await capture("taskkill", ["/PID", String(owner.pid), "/T", "/F"]);
    }

    // A desktop supervisor may already have brought up a replacement. Reuse
    // it rather than starting a competing daemon on the same port.
    await (this.dependencies.wait ?? runtimeWait)(750);
    if (await this.available()) return;
    // Restore the daemon even if the user cancels after it has been stopped.
    // This startup does not load any model or change persistent settings.
    await this.start(true, overrides, executable);
  }

  /** Called only after an explicit user action. Existing unmanaged Ollama is not restarted. */
  async setParallelOne(): Promise<ParallelStatus> {
    if (!isLocalOllamaUrl(this.config.baseUrl)) throw new Error("Cannot configure a remote Ollama server.");
    if (this.dependencies.persistParallel) {
      await this.dependencies.persistParallel();
    } else if (process.platform === "win32") {
      await powershell(`
[Environment]::SetEnvironmentVariable('OLLAMA_NUM_PARALLEL','1','User')
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class TinyCodeEnvironmentBroadcast {
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint msg, IntPtr wParam, string lParam, uint flags, uint timeout, out IntPtr result);
}
'@
$result = [IntPtr]::Zero
[TinyCodeEnvironmentBroadcast]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [IntPtr]::Zero, 'Environment', 2, 1000, [ref]$result) | Out-Null
`);
    }
    process.env.OLLAMA_NUM_PARALLEL = "1";
    this.config.parallel = 1;
    if (this.child && this.child.exitCode === null && !this.child.killed) {
      const owned = this.child;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 2_000);
        owned.once("exit", () => { clearTimeout(timer); resolve(); });
        void stopOwnedProcess(owned, Boolean(this.dependencies.spawnServer)).catch((error) => { clearTimeout(timer); reject(error); });
      });
      this.child = null;
      await this.ensureStarted();
      return { value: 1, source: "TinyCode-managed server", local: true, canSet: true, restartRequired: false };
    }
    return {
      value: 1,
      source: process.platform === "win32" ? "saved in Windows user environment" : "saved for TinyCode-managed startup",
      local: true,
      canSet: true,
      restartRequired: true,
    };
  }
}
