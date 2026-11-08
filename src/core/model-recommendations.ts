import type { InferenceProfileId } from "./inference-profile.js";
import type { HardwareMemoryStatus } from "./runtime.js";

const GIB = 1024 ** 3;
const GB = 1000 ** 3;
const MINIMUM_CONTEXT = 32_768;

export interface RecommendedModel {
  id: string;
  name: string;
  family: string;
  quantization: string;
  totalParametersB: number;
  activeParametersB?: number;
  weightBytes: number;
  contextLength: number;
  kvBytesPerToken: number;
  fixedKvBytes?: number;
  installCommand: string;
  installEngine: "ollama";
  recommendedInference: InferenceProfileId;
  focus: "agentic" | "coding" | "balanced";
  sourceUrl: string;
  /** Curated ordering only; it is not presented as a benchmark score. */
  priority: number;
}

export interface ModelRecommendation extends RecommendedModel {
  placement: "vram" | "hybrid" | "ram";
  recommendedContext: number;
  estimatedMemoryBytes: number;
  note: string;
}

/**
 * Curated 8B+ local coding catalog. Weight sizes follow the published Ollama
 * artifacts; KV values are conservative F16 estimates and are intentionally
 * treated as estimates rather than compatibility guarantees.
 */
export const MODEL_CATALOG: RecommendedModel[] = [
  {
    id: "gemma-4-26b-a4b-ud-q4",
    name: "Gemma 4 26B A4B UD-Q4_K_M",
    family: "gemma4",
    quantization: "UD-Q4_K_M",
    totalParametersB: 26,
    activeParametersB: 4,
    weightBytes: 16_947_541_728,
    contextLength: 262_144,
    kvBytesPerToken: 20_480,
    fixedKvBytes: 200 * 1024 ** 2,
    installCommand: "ollama pull hf.co/unsloth/gemma-4-26B-A4B-it-GGUF:UD-Q4_K_M",
    installEngine: "ollama",
    recommendedInference: "mtp-3",
    focus: "agentic",
    sourceUrl: "https://huggingface.co/unsloth/gemma-4-26B-A4B-it-GGUF",
    priority: 0,
  },
  {
    id: "qwen3-coder-30b-a3b-q4",
    name: "Qwen3-Coder 30B A3.3B Q4_K_M",
    family: "qwen3moe",
    quantization: "Q4_K_M",
    totalParametersB: 30.5,
    activeParametersB: 3.3,
    weightBytes: 19 * GB,
    contextLength: 262_144,
    kvBytesPerToken: 49_152,
    installCommand: "ollama pull qwen3-coder:30b",
    installEngine: "ollama",
    recommendedInference: "standard",
    focus: "agentic",
    sourceUrl: "https://ollama.com/library/qwen3-coder:30b",
    priority: 1,
  },
  {
    id: "devstral-24b-q4",
    name: "Devstral 24B Q4_K_M",
    family: "llama",
    quantization: "Q4_K_M",
    totalParametersB: 23.6,
    weightBytes: 14 * GB,
    contextLength: 131_072,
    kvBytesPerToken: 131_072,
    installCommand: "ollama pull devstral:24b",
    installEngine: "ollama",
    recommendedInference: "standard",
    focus: "agentic",
    sourceUrl: "https://ollama.com/library/devstral:24b",
    priority: 2,
  },
  {
    id: "qwen2.5-coder-32b-q4",
    name: "Qwen2.5-Coder 32B Q4_K_M",
    family: "qwen2",
    quantization: "Q4_K_M",
    totalParametersB: 32,
    weightBytes: 20 * GB,
    contextLength: 32_768,
    kvBytesPerToken: 262_144,
    installCommand: "ollama pull qwen2.5-coder:32b",
    installEngine: "ollama",
    recommendedInference: "standard",
    focus: "coding",
    sourceUrl: "https://ollama.com/library/qwen2.5-coder:32b",
    priority: 3,
  },
  {
    id: "deepseek-coder-v2-lite-16b-q4",
    name: "DeepSeek-Coder-V2 Lite 16B Q4_K_M",
    family: "deepseek2",
    quantization: "Q4_K_M",
    totalParametersB: 16,
    activeParametersB: 2.4,
    weightBytes: 8.9 * GB,
    contextLength: 163_840,
    kvBytesPerToken: 65_536,
    installCommand: "ollama pull deepseek-coder-v2:16b",
    installEngine: "ollama",
    recommendedInference: "standard",
    focus: "coding",
    sourceUrl: "https://ollama.com/library/deepseek-coder-v2:16b",
    priority: 4,
  },
  {
    id: "codestral-22b-q4",
    name: "Codestral 22B Q4_K_M",
    family: "llama",
    quantization: "Q4_K_M",
    totalParametersB: 22,
    weightBytes: 13 * GB,
    contextLength: 32_768,
    kvBytesPerToken: 131_072,
    installCommand: "ollama pull codestral:22b",
    installEngine: "ollama",
    recommendedInference: "standard",
    focus: "coding",
    sourceUrl: "https://ollama.com/library/codestral:22b",
    priority: 5,
  },
  {
    id: "qwen2.5-coder-14b-q4",
    name: "Qwen2.5-Coder 14B Q4_K_M",
    family: "qwen2",
    quantization: "Q4_K_M",
    totalParametersB: 14,
    weightBytes: 9 * GB,
    contextLength: 32_768,
    kvBytesPerToken: 196_608,
    installCommand: "ollama pull qwen2.5-coder:14b",
    installEngine: "ollama",
    recommendedInference: "standard",
    focus: "coding",
    sourceUrl: "https://ollama.com/library/qwen2.5-coder:14b",
    priority: 6,
  },
  {
    id: "qwen3-8b-q4",
    name: "Qwen3 8B Q4_K_M",
    family: "qwen3",
    quantization: "Q4_K_M",
    totalParametersB: 8,
    weightBytes: 5.2 * GB,
    contextLength: 40_960,
    kvBytesPerToken: 147_456,
    installCommand: "ollama pull qwen3:8b",
    installEngine: "ollama",
    recommendedInference: "standard",
    focus: "balanced",
    sourceUrl: "https://ollama.com/library/qwen3:8b",
    priority: 7,
  },
];

function computeReserve(model: RecommendedModel): number {
  return Math.max(512 * 1024 ** 2, model.weightBytes * .05);
}

function estimatedMemory(model: RecommendedModel, context: number): number {
  return model.weightBytes + computeReserve(model) + (model.fixedKvBytes ?? 0) + model.kvBytesPerToken * context;
}

function contextThatFits(model: RecommendedModel, budget: number): number {
  const available = Math.max(0, budget - model.weightBytes - computeReserve(model) - (model.fixedKvBytes ?? 0));
  const tokens = Math.floor(available / model.kvBytesPerToken / 1024) * 1024;
  return Math.max(0, Math.min(model.contextLength, tokens));
}

export function recommendModels(hardware: HardwareMemoryStatus | null): ModelRecommendation[] {
  const ramTotal = hardware?.ram?.totalBytes ?? 0;
  const vramTotal = hardware?.gpus.reduce((sum, gpu) => sum + gpu.totalBytes, 0) ?? 0;
  const usableRam = Math.max(0, ramTotal - Math.max(4 * GIB, ramTotal * .15));
  const usableVram = Math.max(0, vramTotal - Math.max(.75 * GIB, vramTotal * .08));
  const result: ModelRecommendation[] = [];
  for (const model of MODEL_CATALOG) {
    const minimum = Math.min(MINIMUM_CONTEXT, model.contextLength);
    const vramContext = contextThatFits(model, usableVram);
    const combinedContext = contextThatFits(model, usableVram + usableRam);
    const ramContext = contextThatFits(model, usableRam);
    let placement: ModelRecommendation["placement"];
    let recommendedContext: number;
    if (vramContext >= minimum) { placement = "vram"; recommendedContext = vramContext; }
    else if (combinedContext >= minimum && usableVram > 0) { placement = "hybrid"; recommendedContext = combinedContext; }
    else if (ramContext >= minimum) { placement = "ram"; recommendedContext = ramContext; }
    else continue;
    result.push({
      ...model,
      placement,
      recommendedContext,
      estimatedMemoryBytes: estimatedMemory(model, recommendedContext),
      note: placement === "vram" ? "weights, compute reserve and F16 KV fit the VRAM estimate"
        : placement === "hybrid" ? "weights are split between VRAM and system RAM"
          : "RAM-only estimate; expect substantially lower generation speed",
    });
  }
  return result.sort((a, b) => {
    const placement = { vram: 0, hybrid: 1, ram: 2 };
    return placement[a.placement] - placement[b.placement] || a.priority - b.priority || b.recommendedContext - a.recommendedContext;
  });
}
