import { spawn } from "node:child_process";
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";

export function localRuntimeUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && !url.username && !url.password && url.pathname === "/";
  } catch { return false; }
}

export function expandLocalPath(file: string, cwd = process.cwd()): string {
  return path.resolve(cwd, file.replace(/^~(?=$|[\\/])/, os.homedir()));
}

export async function findExecutable(name: string): Promise<string | null> {
  const paths = name.includes("/") || name.includes("\\") ? [expandLocalPath(name)]
    : (process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir.replace(/^"|"$/g, ""), name));
  for (const file of paths) {
    try {
      if (!(await stat(file)).isFile()) continue;
      await access(file, process.platform === "win32" ? constants.F_OK : constants.X_OK);
      return file;
    } catch { /* Next PATH entry. */ }
  }
  return null;
}

/** Fixed argv, never a shell. All captured subprocesses have bounded output and lifetime. */
export async function captureProcess(command: string, args: string[], signal?: AbortSignal, timeoutMs = 15_000, cwd?: string): Promise<string> {
  signal?.throwIfAborted();
  const child = spawn(command, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], shell: false });
  let stdout = "", stderr = "";
  const collect = (previous: string, chunk: string): string => {
    if (previous.length + chunk.length > 4_000_000) { child.kill(); throw new Error("Runtime command output exceeded its limit."); }
    return previous + chunk;
  };
  let overflow = false;
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { try { stdout = collect(stdout, chunk); } catch { overflow = true; } });
  child.stderr.on("data", (chunk: string) => { try { stderr = collect(stderr, chunk); } catch { overflow = true; } });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
  const abort = (): void => { child.kill(); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => {
        if (signal?.aborted) reject(signal.reason ?? new Error("Runtime operation cancelled."));
        else if (timedOut || overflow) reject(new Error(timedOut ? `${command} timed out.` : "Runtime output limit exceeded."));
        else if (code !== 0) reject(new Error(stderr.trim().slice(-1500) || `${command} exited with code ${code}.`));
        else resolve();
      });
    });
    return stdout.trim() || stderr.trim();
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}
