import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function pathExists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }
}

export async function readText(file: string): Promise<string> {
  return readFile(file, "utf8");
}

export async function readJson<T>(file: string): Promise<T | null> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(`Invalid JSON in ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function writeTextAtomic(file: string, body: string): Promise<void> {
  await ensureDir(path.dirname(file));
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, body, { encoding: "utf8", flag: "wx" });
    await rename(temp, file);
  } finally {
    // Never delete the original on rename/locking failure. Keep the previous
    // complete file rather than risking a missing config or session history.
    await rm(temp, { force: true }).catch(() => {});
  }
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

export async function appendJsonl(file: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(file));
  await appendFile(file, `${JSON.stringify(value)}\n`, "utf8");
}

export async function writeJsonl(file: string, values: unknown[]): Promise<void> {
  await ensureDir(path.dirname(file));
  const body = values.map((value) => JSON.stringify(value)).join("\n");
  await writeFile(file, body ? `${body}\n` : "", "utf8");
}

export async function writeJsonlAtomic(file: string, values: unknown[]): Promise<void> {
  const body = values.map((value) => JSON.stringify(value)).join("\n");
  await writeTextAtomic(file, body ? `${body}\n` : "");
}

export async function readJsonl<T>(file: string): Promise<T[]> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
  const out: T[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // Ignore a corrupt line; the rest of the session stays readable.
    }
  }
  return out;
}

export async function listDirs(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

export async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
