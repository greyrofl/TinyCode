import os from "node:os";
import path from "node:path";

/** Root for all TinyCode state. Override with TINYCODE_HOME (useful for tests). */
export function tinycodeHome(): string {
  const override = process.env.TINYCODE_HOME?.trim();
  return override ? path.resolve(override) : path.join(os.homedir(), ".tinytcode");
}

export function configFile(): string {
  return path.join(tinycodeHome(), "config.json");
}

export function sessionsDir(): string {
  return path.join(tinycodeHome(), "sessions");
}

export function historyFile(): string {
  return path.join(tinycodeHome(), "history.json");
}

export function shortPath(file: string): string {
  const home = os.homedir();
  return file.startsWith(home) ? `~${file.slice(home.length)}` : file;
}
