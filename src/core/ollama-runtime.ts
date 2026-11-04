import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Config } from "./config/config.js";

export interface ParallelStatus {
  value: number | null;
  source: string;
  local: boolean;
  canSet: boolean;
  restartRequired?: boolean;
}

export interface RuntimeDependencies {
  fetch?: typeof fetch;
  spawnServer?: (env: NodeJS.ProcessEnv) => ChildProcess;
  persistParallel?: () => Promise<void>;
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
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script], {
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

/** Manage only a local server started by TinyCode; never kill an existing server. */
export class OllamaRuntime {
  private child: ChildProcess | null = null;
  private startError: Error | null = null;
  private starting: Promise<boolean> | null = null;

  constructor(private readonly config: Config["ollama"], private readonly dependencies: RuntimeDependencies = {}) {}

  async available(): Promise<boolean> {
    try {
      const response = await (this.dependencies.fetch ?? fetch)(`${this.config.baseUrl.replace(/\/+$/, "")}/api/version`, {
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

  private async start(): Promise<boolean> {
    if (await this.available()) return false;
    if (!this.config.autoStart || !isLocalOllamaUrl(this.config.baseUrl)) {
      throw new Error(`Ollama is unavailable at ${this.config.baseUrl}. Start the server with ollama serve.`);
    }
    this.startError = null;
    const env = {
      ...process.env,
      OLLAMA_HOST: new URL(this.config.baseUrl).host,
      ...(this.config.parallel !== null ? { OLLAMA_NUM_PARALLEL: String(this.config.parallel) } : {}),
    };
    this.child = this.dependencies.spawnServer ? this.dependencies.spawnServer(env) : spawn("ollama", ["serve"], {
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
    if (this.child && this.child.exitCode === null && !this.child.killed && this.config.parallel !== null) {
      return { value: this.config.parallel, source: "TinyCode-managed server", local, canSet: true };
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
