import os from "node:os";
import { captureProcess } from "./runtime-process.js";

export interface ParallelStatus {
  value: number | null;
  source: string;
  local: boolean;
  canSet: boolean;
  restartRequired?: boolean;
}

export interface HardwareMemoryStatus {
  ram: { totalBytes: number; freeBytes: number } | null;
  gpus: Array<{ id: string; name: string; totalBytes: number; freeBytes: number }>;
  source: string;
}

/** Lifecycle operations shared by local engines. No model is loaded by ensureStarted. */
export interface LocalRuntime {
  available(): Promise<boolean>;
  ensureStarted(signal?: AbortSignal): Promise<boolean>;
  parallelStatus(): Promise<ParallelStatus>;
  memoryStatus(): Promise<HardwareMemoryStatus | null>;
  waitForMemoryRelease(before: HardwareMemoryStatus | null, releasedVram: number, signal?: AbortSignal, minimumFree?: number): Promise<void>;
  restartServer(signal?: AbortSignal): Promise<void>;
  setParallelOne(): Promise<ParallelStatus>;
  /** waitForMemory is used before another engine allocates, not on ordinary process exit. */
  dispose?(waitForMemory?: boolean): Promise<void>;
}

export async function runtimeWait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error("Runtime operation cancelled.");
  await new Promise<void>((resolve, reject) => {
    const finish = (): void => { signal?.removeEventListener("abort", abort); resolve(); };
    const abort = (): void => { clearTimeout(timer); reject(new Error("Runtime operation cancelled.")); };
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/** Host telemetry only; never starts an inference engine. */
export async function readHardwareMemory(): Promise<HardwareMemoryStatus> {
  let ram: HardwareMemoryStatus["ram"] = { totalBytes: os.totalmem(), freeBytes: os.freemem() };
  const sources = ["Node host memory"];
  if (process.platform === "win32") {
    try {
      const script = "$o=Get-CimInstance Win32_OperatingSystem; @{total=[int64]$o.TotalVisibleMemorySize*1KB;free=[int64]$o.FreePhysicalMemory*1KB}|ConvertTo-Json -Compress";
      const raw = await captureProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script], undefined, 10_000);
      const parsed = JSON.parse(raw) as { total?: unknown; free?: unknown };
      if (typeof parsed.total === "number" && typeof parsed.free === "number" && parsed.total > 0 && parsed.free >= 0) {
        ram = { totalBytes: parsed.total, freeBytes: parsed.free }; sources[0] = "Windows physical memory";
      }
    } catch { /* Portable counters remain available. */ }
  }
  const gpus: HardwareMemoryStatus["gpus"] = [];
  try {
    const text = await captureProcess("nvidia-smi", ["--query-gpu=uuid,memory.total,memory.free,name", "--format=csv,noheader,nounits"], undefined, 5_000);
    for (const line of text.split(/\r?\n/)) {
      const [id, total, free, ...name] = line.split(",").map((value) => value.trim());
      if (id && Number.isFinite(Number(total)) && Number.isFinite(Number(free))) gpus.push({ id, name: name.join(", ") || "NVIDIA GPU", totalBytes: Number(total) * 1024 ** 2, freeBytes: Number(free) * 1024 ** 2 });
    }
    if (gpus.length) sources.push("nvidia-smi");
  } catch { /* CPU/AMD/integrated hardware: GPU telemetry stays unknown. */ }
  return { ram, gpus, source: sources.join(" + ") };
}
