import { spawn } from "node:child_process";
import path from "node:path";
import { readOptionalBoolean, readOptionalInt, readOptionalString } from "./args.js";
import { resolveInCwd } from "./paths.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";

async function runGit(
  args: string[],
  context: ToolContext,
  timeoutMs = 30_000,
): Promise<ToolResult> {
  if (context.signal.aborted) throw new Error("Git command aborted.");
  const child = spawn("git", ["--no-pager", ...args], {
    cwd: context.cwd,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_PAGER: "cat", PAGER: "cat", NO_COLOR: "1" },
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  const max = Math.max(2_000, context.config.tools.maxOutputChars);
  child.stdout.on("data", (chunk: string) => {
    if (stdout.length < max) stdout += chunk.slice(0, max - stdout.length);
  });
  child.stderr.on("data", (chunk: string) => {
    if (stderr.length < max) stderr += chunk.slice(0, max - stderr.length);
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);
  const onAbort = (): void => {
    child.kill();
  };
  context.signal.addEventListener("abort", onAbort, { once: true });
  const code = await new Promise<number>((resolve) => {
    child.once("error", (error) => {
      stderr += error.message;
      resolve(1);
    });
    child.once("close", (value) => resolve(value ?? 1));
  }).finally(() => {
    clearTimeout(timer);
    context.signal.removeEventListener("abort", onAbort);
  });
  if (context.signal.aborted) throw new Error("Git command aborted.");

  const output = [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join("\n\nstderr:\n") || "(no output)";
  if (timedOut) return { ok: false, output: `Git command timed out.\n${output}` };
  return { ok: code === 0, output: code === 0 ? output : `git exited with code ${code}:\n${output}` };
}

function optionalPath(input: Record<string, unknown>, context: ToolContext): string | undefined {
  const requested = readOptionalString(input, "path", { trim: true });
  if (!requested) return undefined;
  const absolute = resolveInCwd(context.cwd, requested);
  return path.relative(context.cwd, absolute) || ".";
}

export const gitStatusTool: Tool = {
  definition: {
    name: "git_status",
    description: "Show the current branch and concise working-tree status. Read-only.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    safe: true,
    summary: () => "working tree",
  },
  run: (input, context) => {
    void input;
    return runGit(["status", "--short", "--branch", "--untracked-files=all"], context);
  },
};

export const gitDiffTool: Tool = {
  definition: {
    name: "git_diff",
    description: "Show unstaged or staged Git changes, optionally limited to one path. Read-only.",
    parameters: {
      type: "object",
      properties: {
        staged: { type: "boolean", description: "Show staged rather than unstaged changes.", default: false },
        path: { type: "string", description: "Optional path relative to cwd." },
        contextLines: { type: "integer", description: "Surrounding diff lines (0-20).", default: 3 },
      },
      required: [],
      additionalProperties: false,
    },
    safe: true,
    summary: (input) => `${input.staged === true ? "staged" : "unstaged"}${input.path ? ` · ${input.path}` : ""}`,
  },
  async run(input, context): Promise<ToolResult> {
    const staged = readOptionalBoolean(input, "staged", false);
    const contextLines = readOptionalInt(input, "contextLines", 3, 0, 20);
    const requested = optionalPath(input, context);
    const args = ["diff", "--no-ext-diff", `--unified=${contextLines}`];
    if (staged) args.push("--cached");
    if (requested) args.push("--", requested);
    return runGit(args, context);
  },
};

export const gitLogTool: Tool = {
  definition: {
    name: "git_log",
    description: "Show recent commits as a compact graph. Read-only.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "Maximum recent commits (1-100).", default: 15 },
        path: { type: "string", description: "Optional path history." },
      },
      required: [],
      additionalProperties: false,
    },
    safe: true,
    summary: (input) => `last ${typeof input.limit === "number" ? input.limit : 15} commits`,
  },
  async run(input, context): Promise<ToolResult> {
    const limit = readOptionalInt(input, "limit", 15, 1, 100);
    const requested = optionalPath(input, context);
    const args = ["log", `-${limit}`, "--oneline", "--decorate", "--graph"];
    if (requested) args.push("--", requested);
    return runGit(args, context);
  },
};

export const gitShowTool: Tool = {
  definition: {
    name: "git_show",
    description: "Show a commit or a file at a Git revision. Read-only.",
    parameters: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Git commit or ref to inspect.", default: "HEAD" },
        path: { type: "string", description: "Optional file path. With path, returns ref:path content." },
      },
      required: [],
      additionalProperties: false,
    },
    safe: true,
    summary: (input) => `${typeof input.ref === "string" ? input.ref : "HEAD"}${input.path ? `:${input.path}` : ""}`,
  },
  async run(input, context): Promise<ToolResult> {
    const ref = readOptionalString(input, "ref", { trim: true }) || "HEAD";
    if (ref.startsWith("-") || !/^[A-Za-z0-9_./~^@{}:+-]+$/.test(ref)) {
      return { ok: false, output: "Invalid Git ref." };
    }
    const requested = optionalPath(input, context);
    if (requested) return runGit(["show", `${ref}:${requested.split(path.sep).join("/")}`], context);
    return runGit(["show", "--stat", "--oneline", "--decorate", ref], context);
  },
};
