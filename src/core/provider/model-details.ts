import type { ModelDetails } from "./types.js";

/** Capability discovery never invents named thinking levels. */
export function parseModelDetails(model: string, raw: Record<string, unknown>): ModelDetails {
  const details = (raw.details ?? {}) as Record<string, unknown>;
  const info = (raw.model_info ?? {}) as Record<string, unknown>;
  const family = typeof details.family === "string" ? details.family : String(info["general.architecture"] ?? "");
  const contextValue = Object.entries(info).find(([key]) => key.endsWith(".context_length"))?.[1];
  const capabilities = Array.isArray(raw.capabilities) ? raw.capabilities : [];
  const metadata = raw.thinking as { values?: unknown[]; default?: unknown } | undefined;
  const parameterText = typeof raw.parameters === "string" ? raw.parameters : "";
  const parameterMap = Object.fromEntries(parameterText.split(/\r?\n/).flatMap((line) => {
    const match = /^([a-z_]+)\s+(-?\d+(?:\.\d+)?)\s*$/.exec(line.trim());
    return match ? [[match[1]!, Number(match[2])]] : [];
  }));
  const number = (suffix: string): number | undefined => {
    const value = Object.entries(info).find(([key]) => key.endsWith(suffix))?.[1];
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
  };
  const blocks = number(".block_count");
  const heads = number(".attention.head_count");
  const kvHeads = number(".attention.head_count_kv");
  const embedding = number(".embedding_length");
  const keyLength = number(".attention.key_length") ?? (embedding && heads ? embedding / heads : undefined);
  const valueLength = number(".attention.value_length") ?? keyLength;
  let contextMemory: ModelDetails["contextMemory"];
  if (blocks && kvHeads && keyLength && valueLength) {
    contextMemory = { variableKvBytesPerToken: blocks * kvHeads * (keyLength + valueLength) * 2, confidence: "metadata" };
  } else if (family === "gemma4" && blocks && heads && keyLength && valueLength) {
    // Gemma 4 stores five sliding-window layers followed by one global layer.
    // Array metadata is omitted by non-verbose /api/show, but this architecture
    // has a stable pattern. Only global layers grow with num_ctx.
    const globalLayers = Math.floor(blocks / 6);
    const localLayers = blocks - globalLayers;
    const globalKvHeads = Math.max(1, heads / 8);
    const localKvHeads = Math.max(1, heads / 2);
    const keySwa = number(".attention.key_length_swa") ?? keyLength;
    const valueSwa = number(".attention.value_length_swa") ?? valueLength;
    const window = number(".attention.sliding_window") ?? 1024;
    contextMemory = {
      variableKvBytesPerToken: globalLayers * globalKvHeads * (keyLength + valueLength) * 2,
      fixedKvBytes: localLayers * localKvHeads * (keySwa + valueSwa) * 2 * window,
      confidence: "heuristic",
    };
  }
  const modeFor = (value: unknown): string | null =>
    value === false ? "off" : value === true ? "on" : typeof value === "string" && value.trim() ? value : null;
  const discovered = metadata?.values?.map(modeFor).filter((mode): mode is string => mode !== null);
  const supportsThinking = capabilities.includes("thinking") || discovered?.some((mode) => mode !== "off");
  const knownBooleanControls = family === "qwen3" || family === "qwen35";
  const modes = discovered?.length ? [...new Set(discovered)]
    : supportsThinking ? knownBooleanControls ? ["off", "on"] : ["auto"] : ["off"];
  const template = typeof raw.template === "string" ? raw.template : "";
  // Older HF Go templates unconditionally append <think>, ignoring think:false.
  const brokenQwenOff = family === "qwen3" && !metadata && template.includes("{{") &&
    template.includes("<think>") && !template.includes("enable_thinking") && !/\b\.Think\b/.test(template);
  const declaredDefault = modeFor(metadata?.default);
  const defaultMode = declaredDefault && modes.includes(declaredDefault) ? declaredDefault
    : modes.includes("on") ? "on" : modes[0]!;
  return {
    id: model,
    name: model,
    family,
    parameterSize: typeof details.parameter_size === "string" ? details.parameter_size : undefined,
    quantization: typeof details.quantization_level === "string" ? details.quantization_level : undefined,
    contextLength: typeof contextValue === "number" && Number.isFinite(contextValue) ? contextValue : undefined,
    contextMemory,
    samplingDefaults: {
      temperature: parameterMap.temperature,
      topP: parameterMap.top_p,
      topK: parameterMap.top_k,
      minP: parameterMap.min_p,
      repeatPenalty: parameterMap.repeat_penalty,
      presencePenalty: parameterMap.presence_penalty,
    },
    thinking: {
      modes,
      defaultMode,
      control: !supportsThinking ? "none" : brokenQwenOff ? "prompt" : "native",
      values: Object.fromEntries((metadata?.values ?? []).flatMap((value) => {
        const mode = modeFor(value);
        return mode && (typeof value === "boolean" || typeof value === "string") ? [[mode, value]] : [];
      })),
      note: brokenQwenOff ? "HF template workaround: Off uses a closed-thinking ChatML prompt through Ollama /api/generate."
        : supportsThinking && !discovered?.length && !knownBooleanControls
          ? "This model does not advertise supported thinking controls; only its default mode is offered."
          : undefined,
    },
  };
}

export function thinkingValue(mode: string, details?: ModelDetails): boolean | string | undefined {
  if (mode === "auto") return undefined;
  return details?.thinking.values?.[mode] ?? (mode === "off" ? false : mode === "on" ? true : mode);
}

export function qwenNonThinkingPrompt(messages: Array<{ role: string; content: string }>): string {
  return messages.map((message) =>
    `<|im_start|>${message.role}\n${message.content}<|im_end|>\n`,
  ).join("") + "<|im_start|>assistant\n<think>\n\n</think>\n\n";
}
