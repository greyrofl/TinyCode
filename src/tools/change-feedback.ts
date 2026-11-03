import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

export function fileChangeFeedback(file: string, before: string, after: string): string {
  const oldLines = before.split(/\r?\n/);
  const newLines = after.split(/\r?\n/);
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
  let suffix = 0;
  while (suffix < oldLines.length - start && suffix < newLines.length - start &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) suffix++;
  const removed = oldLines.slice(start, oldLines.length - suffix);
  const added = newLines.slice(start, newLines.length - suffix);
  const from = Math.max(0, start - 2);
  const to = Math.min(newLines.length, start + Math.max(added.length, 1) + 3);
  const diff = [
    `Diff: ${file}`,
    `@@ -${start + 1},${removed.length} +${start + 1},${added.length} @@`,
    ...removed.slice(0, 20).map((line) => `-${line}`),
    ...added.slice(0, 20).map((line) => `+${line}`),
    "",
    `Current lines ${from + 1}-${to}:`,
    ...newLines.slice(from, Math.min(to, from + 30)).map((line, index) => `${from + index + 1}: ${line}`),
  ].join("\n");
  return diff.length > 3_000 ? `${diff.slice(0, 3_000)}\n… preview truncated; read_file for more.` : diff;
}

const IGNORED = new Set([".git", "node_modules", "dist", "build", "coverage", ".next", ".cache", ".venv", "target"]);

/** Metadata only: detect command changes without reading or exposing file contents. */
export async function workspaceStamp(cwd: string): Promise<string | null> {
  const hash = createHash("sha256");
  const queue = [cwd];
  let count = 0;
  try {
    while (queue.length) {
      const dir = queue.shift()!;
      const entries = await readdir(dir, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (++count > 10_000) return null;
        if (IGNORED.has(entry.name) || entry.isSymbolicLink()) continue;
        const absolute = path.join(dir, entry.name);
        if (entry.isDirectory()) queue.push(absolute);
        else if (entry.isFile()) {
          const info = await stat(absolute);
          hash.update(`${path.relative(cwd, absolute)}:${info.size}:${info.mtimeMs}\n`);
        }
      }
    }
    return hash.digest("hex");
  } catch { return null; }
}

export function isVerificationCommand(command: string): boolean {
  if (/[|;\r\n]|(?<!&)&(?!&)/.test(command)) return false;
  return /(?:^|&&\s*)(?:npm\s+(?:test\b|run\s+(?:test|build|check|typecheck|lint)\b)|pnpm\s+(?:run\s+)?(?:test|build|check|typecheck|lint)\b|yarn\s+(?:run\s+)?(?:test|build|check|typecheck|lint)\b|node\s+--(?:test|check)\b|npx\s+(?:tsc|vitest|jest)\b|pytest\b|python\s+-m\s+(?:pytest|unittest|compileall)\b|cargo\s+(?:test|check|build)\b|go\s+test\b|dotnet\s+(?:test|build)\b|cmake\s+--build\b|mvn\s+test\b|ctest\b)/i.test(command.trim());
}

export function verificationKinds(command: string): Set<string> {
  const kinds = new Set<string>();
  if (!isVerificationCommand(command)) return kinds;
  if (/(?:npm\s+(?:test|run\s+test)\b|(?:pnpm|yarn)\s+(?:test|run\s+test)\b|node\s+--test\b|npx\s+(?:vitest|jest)\b|pytest\b|python\s+-m\s+(?:pytest|unittest)\b|cargo\s+test\b|go\s+test\b|dotnet\s+test\b|mvn\s+test\b|ctest\b)/i.test(command)) kinds.add("test");
  if (/(?:npm\s+run\s+build\b|(?:pnpm|yarn)\s+(?:run\s+)?build\b|cargo\s+build\b|cmake\s+--build\b|dotnet\s+build\b)/i.test(command)) kinds.add("build");
  kinds.add("check");
  return kinds;
}
