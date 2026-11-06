import path from "node:path";
import { realpath, stat } from "node:fs/promises";

/**
 * File tools are confined to the session working directory. Command/script
 * execution and MCP tools are not sandboxed by these path checks.
 */
export function resolveInCwd(cwd: string, requested: string): string {
  if (!requested || !requested.trim()) throw new Error("path must not be empty.");
  const absolute = path.isAbsolute(requested) ? path.normalize(requested) : path.resolve(cwd, requested);
  const relative = path.relative(cwd, absolute);
  const escapes =
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    relative.startsWith(`..${path.posix.sep}`) ||
    path.isAbsolute(relative);
  if (escapes) throw new Error(`Path escapes the working directory: ${requested}`);
  return absolute;
}

export function relativeDisplay(cwd: string, absolute: string): string {
  const relative = path.relative(cwd, absolute);
  return relative && !relative.startsWith("..") ? relative : absolute;
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

/**
 * Lexical checks are not enough: a symlink inside cwd can point outside it.
 * Resolve the existing target (or the closest existing ancestor for a new
 * file) and verify that its real path is still below the real cwd.
 */
export async function assertRealPathInCwd(
  cwd: string,
  target: string,
  allowMissingLeaf = false,
): Promise<void> {
  const root = await realpath(cwd);
  let candidate = target;

  if (allowMissingLeaf) {
    for (;;) {
      const exists = await stat(candidate).then(
        () => true,
        () => false,
      );
      if (exists) break;
      const parent = path.dirname(candidate);
      if (parent === candidate) throw new Error(`No existing parent for path: ${target}`);
      candidate = parent;
    }
  }

  const resolved = await realpath(candidate);
  if (!isInside(root, resolved)) {
    throw new Error(`Path resolves outside the working directory: ${target}`);
  }
}
