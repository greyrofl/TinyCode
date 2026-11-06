import type { Config } from "./config/config.js";

/** Read total parameters from the model name, not its owner or MoE active count. */
export function modelParameterBillions(model: string): number | null {
  const name = (model.split(/[\\/]/).at(-1) ?? model).normalize("NFKC");
  // A4B / A 4B means active parameters, not the full model size.
  const withoutActive = name.replace(/(?:^|[^A-Za-z0-9])a\s*\d+(?:[.,]\d+)?\s*b(?![A-Za-z0-9])/gi, " ");
  const match = /(?:^|[^A-Za-z0-9.,])(\d+(?:[.,]\d+)?)\s*b(?![A-Za-z0-9])/i.exec(withoutActive);
  if (!match) return null;
  const size = Number(match[1]!.replace(",", "."));
  return Number.isFinite(size) && size > 0 ? size : null;
}

export function defaultToolProfile(model: string): "auto" | "full" {
  const size = modelParameterBillions(model);
  return size !== null && size >= 20 ? "full" : "auto";
}

export function resolveToolProfile(config: Config, model: string): Config["tools"]["profile"] {
  return config.tools.profileByModel && config.tools.profile === "auto"
    ? defaultToolProfile(model)
    : config.tools.profile;
}
