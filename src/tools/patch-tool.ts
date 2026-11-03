import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { fileChangeFeedback } from "./change-feedback.js";
import { readString } from "./args.js";
import { assertRealPathInCwd, resolveInCwd } from "./paths.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";

const MAX_PATCH_CHARS = 2_000_000;

function cleanPatchPath(raw: string): string | null {
  const value = raw.split("\t", 1)[0]!.trim();
  if (value === "/dev/null") return null;
  if (value.startsWith('"') || value.endsWith('"')) {
    throw new Error("Quoted patch paths are not supported; use simple relative paths.");
  }
  return value.replace(/^[ab]\//, "");
}

function patchPaths(patch: string): string[] {
  const paths = new Set<string>();
  const lines = patch.split(/\r?\n/);
  for (let index = 0; index < lines.length - 1; index++) {
    const before = lines[index]!;
    const after = lines[index + 1]!;
    if (!before.startsWith("--- ") || !after.startsWith("+++ ")) continue;
    const oldPath = cleanPatchPath(before.slice(4));
    const newPath = cleanPatchPath(after.slice(4));
    if (oldPath) paths.add(oldPath);
    if (newPath) paths.add(newPath);
    index++;
  }
  if (paths.size === 0) throw new Error("No ---/+++ file headers found in the unified diff.");
  return [...paths];
}

async function validatePaths(cwd: string, paths: string[]): Promise<void> {
  for (const requested of paths) {
    const absolute = resolveInCwd(cwd, requested);
    const exists = await stat(absolute).then(
      () => true,
      () => false,
    );
    await assertRealPathInCwd(cwd, absolute, !exists);
  }
}

async function gitApply(
  cwd: string,
  patch: string,
  check: boolean,
  signal: AbortSignal,
): Promise<{ code: number; stdout: string; stderr: string }> {
  if (signal.aborted) throw new Error("Patch aborted.");
  const args = ["apply", "--recount", "--whitespace=nowarn"];
  if (check) args.push("--check");
  args.push("-");

  const child = spawn("git", args, {
    cwd,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: string) => (stdout += chunk));
  child.stderr.on("data", (chunk: string) => (stderr += chunk));

  const onAbort = (): void => {
    child.kill();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  child.stdin.end(patch);
  const code = await new Promise<number>((resolve) => {
    child.once("error", (error) => {
      stderr += error.message;
      resolve(1);
    });
    child.once("close", (value) => resolve(value ?? 1));
  }).finally(() => signal.removeEventListener("abort", onAbort));
  if (signal.aborted) throw new Error("Patch aborted.");
  return { code, stdout, stderr };
}

export const applyPatchTool: Tool = {
  definition: {
    name: "apply_patch",
    description:
      "Apply a standard unified diff to one or more files. The patch is checked before it is applied. Use edit_file for a small exact replacement.",
    parameters: {
      type: "object",
      properties: {
        patch: {
          type: "string",
          description: "Unified diff containing ---/+++ headers and @@ hunks. Paths must stay inside the working directory.",
        },
      },
      required: ["patch"],
      additionalProperties: false,
    },
    safe: false,
    summary: (input) => {
      if (typeof input.patch !== "string") return "unified diff";
      try {
        return patchPaths(input.patch).join(", ");
      } catch {
        return "unified diff";
      }
    },
  },
  async run(input, context): Promise<ToolResult> {
    const patch = readString(input, "patch", { allowEmpty: false });
    if (patch.length > MAX_PATCH_CHARS) {
      return { ok: false, output: `Patch exceeds ${MAX_PATCH_CHARS} characters.` };
    }
    let paths: string[];
    try {
      paths = patchPaths(patch);
      await validatePaths(context.cwd, paths);
    } catch (error) {
      return { ok: false, output: `Invalid patch: ${(error as Error).message}` };
    }

    const checked = await gitApply(context.cwd, patch, true, context.signal);
    if (checked.code !== 0) {
      return {
        ok: false,
        output: `Patch check failed (no files changed):\n${checked.stderr.trim() || checked.stdout.trim() || "unknown error"}`,
      };
    }
    const before = await Promise.all(paths.map(async (name) => readFile(resolveInCwd(context.cwd, name), "utf8").catch(() => "")));
    const applied = await gitApply(context.cwd, patch, false, context.signal);
    if (applied.code !== 0) {
      return {
        ok: false,
        output: `Patch passed validation but failed to apply:\n${applied.stderr.trim() || applied.stdout.trim()}`,
      };
    }
    const after = await Promise.all(paths.map(async (name) => readFile(resolveInCwd(context.cwd, name), "utf8").catch(() => "")));
    const changed = paths.filter((_, index) => before[index] !== after[index]);
    if (!changed.length) return { ok: false, changed: false, output: "Patch produced no file changes." };
    const previews = paths.flatMap((name, index) => before[index] !== after[index] ? [fileChangeFeedback(name, before[index]!, after[index]!)] : []);
    return {
      ok: true,
      changed: true,
      changedPaths: changed.map((name) => resolveInCwd(context.cwd, name)),
      output: `Applied patch to ${changed.length} paths: ${changed.join(", ")}.\n\n${previews.join("\n\n").slice(0, context.config.tools.maxOutputChars)}`,
    };
  },
};
