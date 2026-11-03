import { readFileSync } from "node:fs";

let cached: string | null = null;

export function version(): string {
  if (cached !== null) return cached;
  try {
    const file = new URL("../package.json", import.meta.url);
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { version?: string };
    cached = parsed.version ?? "0.0.0";
  } catch {
    cached = "0.0.0";
  }
  return cached;
}
