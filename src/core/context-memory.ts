import type { ModelDetails, RunningModelInfo } from "./provider/types.js";
import type { HardwareMemoryStatus } from "./runtime.js";

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

export interface ContextCapacity {
  modelLimit: number;
  loadedContext: number | null;
  maximum: number;
  exact: boolean;
  vramMaximum: number | null;
  placement: "gpu" | "mixed" | "ram" | "unknown";
  memoryKnown: boolean;
  bytesPerToken: number | null;
  parallel: number;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function roundContext(value: number, modelLimit: number): number {
  if (value >= modelLimit) return modelLimit;
  const step = value >= 65_536 ? 4096 : value >= 16_384 ? 2048 : 1024;
  return Math.max(256, Math.floor(value / step) * step);
}

/**
 * Estimate the largest runner context from a real loaded allocation plus live
 * free memory. It never assumes that weights or KV are all on one device.
 */
export function calculateContextCapacity(input: {
  details: ModelDetails;
  running: RunningModelInfo | null;
  hardware: HardwareMemoryStatus | null;
  parallel?: number | null;
  requestedContext: number;
  forceCpu?: boolean;
}): ContextCapacity {
  const modelLimit = Math.max(256, Math.floor(input.details.contextLength ?? input.requestedContext));
  const running = input.running;
  const parallel = Math.max(1, Math.floor(input.parallel ?? 1));
  const loadedContext = running
    ? Math.max(256, Math.floor(Math.min(running.contextLength, input.requestedContext)))
    : null;
  const baseline = Math.min(modelLimit, loadedContext ?? input.requestedContext);
  const metadataBytes = finite(input.details.contextMemory?.variableKvBytesPerToken);
  // Unknown architectures get a deliberately conservative slope. The result
  // remains marked approximate and the currently loaded size is always valid.
  const fallbackBytes = running && running.contextLength > 0
    ? Math.max(16 * 1024, Math.min(1024 * 1024, running.sizeBytes * 0.12 / running.contextLength))
    : null;
  const bytesPerToken = metadataBytes ?? fallbackBytes;
  const selectedBytesPerToken = bytesPerToken === null ? null : bytesPerToken * parallel;

  const total = finite(running?.sizeBytes) ?? null;
  const vram = finite(running?.sizeVramBytes) ?? 0;
  const placement: ContextCapacity["placement"] = running?.memoryKnown === false ? "unknown" : input.forceCpu || vram === 0
    ? running ? "ram" : "unknown"
    : total === null ? "unknown"
      : vram >= total * 0.95 ? "gpu" : "mixed";

  const ram = input.hardware?.ram;
  const gpuTotal = input.hardware?.gpus.reduce((sum, gpu) => sum + gpu.totalBytes, 0) ?? 0;
  const gpuFree = input.hardware?.gpus.reduce((sum, gpu) => sum + gpu.freeBytes, 0) ?? 0;
  // Fixed reserves work while plenty of memory is free, but must shrink when a
  // large mixed model is already resident. Otherwise a 2.5 GiB RAM reserve can
  // consume the entire remaining budget and incorrectly make the 4k baseline
  // look like the physical maximum. Always retain at least 75% of currently
  // free memory as potential KV growth; allocation remains an estimate and an
  // oversized choice is still guarded by the bounded startup/OOM path.
  const adaptiveHeadroom = (free: number, reserve: number): number =>
    Math.max(0, free - Math.min(reserve, free * 0.25));
  const ramHeadroom = ram
    ? adaptiveHeadroom(ram.freeBytes, Math.max(GIB, ram.totalBytes * 0.08))
    : 0;
  const gpuHeadroom = gpuTotal > 0
    ? adaptiveHeadroom(gpuFree, Math.max(256 * MIB, gpuTotal * 0.04))
    : 0;
  // A loaded baseline plus live free RAM/VRAM and a KV slope is enough to
  // estimate growth even when llama.cpp startup logs did not expose the exact
  // weight split. Allocation telemetry is needed only for placement/VRAM labels.
  const memoryKnown = selectedBytesPerToken !== null && running !== null && Boolean(ram || gpuTotal > 0);

  let maximum = baseline;
  if (selectedBytesPerToken !== null && selectedBytesPerToken > 0 && memoryKnown) {
    maximum = Math.min(modelLimit, baseline + Math.floor((ramHeadroom + (input.forceCpu ? 0 : gpuHeadroom)) / selectedBytesPerToken));
  } else if (!running) {
    maximum = Math.min(modelLimit, input.requestedContext);
  }
  maximum = roundContext(maximum, modelLimit);

  let vramMaximum: number | null = null;
  if (!running || running.memoryKnown === false) {
    vramMaximum = null;
  } else if (input.forceCpu || placement === "ram" || placement === "mixed") {
    vramMaximum = 0;
  } else if (selectedBytesPerToken !== null && gpuTotal > 0) {
    // If the currently loaded model is already mixed, no context size can be
    // described as model+KV fully resident in VRAM. This remains informative
    // without treating mixed offload as an error.
    vramMaximum = placement === "gpu"
      ? roundContext(Math.min(modelLimit, baseline + Math.floor(gpuHeadroom / selectedBytesPerToken)), modelLimit)
      : 0;
  }

  return {
    modelLimit,
    loadedContext,
    maximum,
    exact: maximum === modelLimit && memoryKnown,
    vramMaximum,
    placement,
    memoryKnown,
    bytesPerToken,
    parallel,
  };
}

export function contextCapacityMessage(capacity: ContextCapacity): string {
  const max = capacity.maximum.toLocaleString("en-US");
  const top = capacity.exact
      ? `Max context: ${max} tokens (exact model limit; estimated to fit).`
      : `Max context: ≈${max} tokens (memory estimate).`;
  const loaded = capacity.loadedContext
    ? `Loaded: ${capacity.loadedContext.toLocaleString("en-US")} · ${capacity.placement}.`
    : `Placement: ${capacity.placement}; loaded allocation unavailable.`;
  const caveat = capacity.memoryKnown
    ? "RAM ctx means model + context are not fully VRAM-resident."
    : "Memory data unavailable; model limit and current context are shown.";
  return `${top} ${loaded} ${caveat}`;
}

export function contextChoices(modelLimit: number, current: number, maximum: number, minimum: number): number[] {
  return [...new Set([
    2048, 4096, 8192, 12288, 16384, 32768, 65536, 131072, 262144,
    current, maximum, minimum,
  ].map((value) => Math.max(256, Math.floor(value))))]
    .filter((value) => value <= modelLimit)
    .sort((a, b) => a - b);
}
