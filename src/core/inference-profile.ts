export const INFERENCE_PROFILE_IDS = ["standard", "ngram", "mtp-2", "mtp-3", "mtp-6", "mtp-8"] as const;

export type InferenceProfileId = typeof INFERENCE_PROFILE_IDS[number];

export interface InferencePreference {
  profile: InferenceProfileId;
  /** MTP sidecar for this target model. TinyCode never downloads it. */
  draftModel?: string;
}

export interface InferenceRuntimeOptions {
  profile: InferenceProfileId;
  speculativeType: "none" | "ngram-mod" | "draft-mtp";
  draftModel?: string;
  mtpMode?: "auto" | "embedded" | "sidecar";
  draftDevice: "auto" | "cpu";
  draftMax: number;
  draftCacheTypeK: string;
  draftCacheTypeV: string;
}

export function isInferenceProfile(value: unknown): value is InferenceProfileId {
  return typeof value === "string" && (INFERENCE_PROFILE_IDS as readonly string[]).includes(value);
}

export function inferenceProfileLabel(profile: InferenceProfileId | undefined): string {
  profile ??= "standard";
  if (profile === "standard") return "Standard";
  if (profile === "ngram") return "N-gram";
  return `MTP ${profile.slice(4)}x`;
}

export function isMtpProfile(profile: InferenceProfileId): boolean {
  return profile.startsWith("mtp-");
}

export function inferenceProfileFromSpeculative(
  type: "none" | "ngram-mod" | "draft-mtp",
  draftMax: number,
): InferenceProfileId {
  if (type === "ngram-mod") return "ngram";
  if (type === "draft-mtp") {
    if (draftMax <= 2) return "mtp-2";
    if (draftMax <= 3) return "mtp-3";
    if (draftMax <= 6) return "mtp-6";
    return "mtp-8";
  }
  return "standard";
}

export function inferenceRuntimeOptions(
  profile: InferenceProfileId,
  defaults: {
    speculativeDraftModel: string | null;
    speculativeDraftDevice: "auto" | "cpu";
    speculativeDraftCacheTypeK: string;
    speculativeDraftCacheTypeV: string;
    speculativeMtpMode?: "auto" | "embedded" | "sidecar";
  },
  draftModel?: string,
  draftMax?: number,
): InferenceRuntimeOptions {
  const mtp = isMtpProfile(profile);
  return {
    profile,
    speculativeType: profile === "ngram" ? "ngram-mod" : mtp ? "draft-mtp" : "none",
    mtpMode: defaults.speculativeMtpMode ?? "auto",
    ...(mtp && defaults.speculativeMtpMode !== "embedded" && (draftModel || defaults.speculativeDraftModel)
      ? { draftModel: draftModel || defaults.speculativeDraftModel! }
      : {}),
    draftDevice: defaults.speculativeDraftDevice,
    draftMax: mtp ? draftMax ?? Number(profile.slice(4)) : 0,
    draftCacheTypeK: defaults.speculativeDraftCacheTypeK,
    draftCacheTypeV: defaults.speculativeDraftCacheTypeV,
  };
}
