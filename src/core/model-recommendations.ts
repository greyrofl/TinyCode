import type { HardwareMemoryStatus } from "./runtime.js";

const GIB = 1024 ** 3;

export interface RecommendedModel {
  id: string;
  name: string;
  totalParametersB: number;
  activeParametersB?: number;
  weightBytes: number;
  contextLength: number;
  kvBytesPerToken: number;
  installCommand: string;
  installEngine: "ollama";
}

export interface ModelRecommendation extends RecommendedModel {
  placement: "vram" | "hybrid" | "ram";
  recommendedContext: number;
  note: string;
}

/** Small seed catalog for 0.6 UI validation; entries are data, not auto-downloads. */
export const MODEL_CATALOG: RecommendedModel[] = [
  {
    id: "qwen2.5-coder-7b-q4",
    name: "Qwen2.5-Coder 7B Q4_K_M",
    totalParametersB: 7,
    weightBytes: 4.7 * GIB,
    contextLength: 32_768,
    kvBytesPerToken: 57_344,
    installCommand: "ollama pull qwen2.5-coder:7b",
    installEngine: "ollama",
  },
  {
    id: "gemma-4-26b-a4b-ud-q4",
    name: "Gemma 4 26B A4B UD-Q4_K_M",
    totalParametersB: 26,
    activeParametersB: 4,
    weightBytes: 15.78 * GIB,
    contextLength: 262_144,
    kvBytesPerToken: 20_480,
    installCommand: "ollama pull hf.co/unsloth/gemma-4-26B-A4B-it-GGUF:UD-Q4_K_M",
    installEngine: "ollama",
  },
];

function contextThatFits(model: RecommendedModel, budget: number): number {
  const compute = Math.max(256 * 1024 ** 2, model.weightBytes * .04);
  const available = Math.max(0, budget - model.weightBytes - compute);
  const tokens = Math.floor(available / model.kvBytesPerToken / 1024) * 1024;
  return Math.max(0, Math.min(model.contextLength, tokens));
}

export function recommendModels(hardware: HardwareMemoryStatus | null): ModelRecommendation[] {
  const ramTotal = hardware?.ram?.totalBytes ?? 0;
  const vramTotal = hardware?.gpus.reduce((sum, gpu) => sum + gpu.totalBytes, 0) ?? 0;
  const usableRam = Math.max(0, ramTotal - Math.max(4 * GIB, ramTotal * .15));
  const usableVram = Math.max(0, vramTotal - Math.max(.5 * GIB, vramTotal * .08));
  const result: ModelRecommendation[] = [];
  for (const model of MODEL_CATALOG) {
    const vramContext = contextThatFits(model, usableVram);
    const combinedContext = contextThatFits(model, usableVram + usableRam);
    const ramContext = contextThatFits(model, usableRam);
    let placement: ModelRecommendation["placement"];
    let recommendedContext: number;
    if (vramContext >= 32_768) { placement = "vram"; recommendedContext = vramContext; }
    else if (combinedContext >= 32_768 && usableVram > 0) { placement = "hybrid"; recommendedContext = combinedContext; }
    else if (ramContext >= 32_768) { placement = "ram"; recommendedContext = ramContext; }
    else continue;
    result.push({
      ...model,
      placement,
      recommendedContext,
      note: placement === "vram" ? "weights + recommended context fit VRAM estimate"
        : placement === "hybrid" ? "some layers remain in RAM"
          : "RAM-only estimate; expect low speed",
    });
  }
  return result.sort((a, b) => {
    const placement = { vram: 0, hybrid: 1, ram: 2 };
    return placement[a.placement] - placement[b.placement] || b.totalParametersB - a.totalParametersB || b.recommendedContext - a.recommendedContext;
  });
}
