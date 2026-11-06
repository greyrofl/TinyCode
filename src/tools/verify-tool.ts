import { spawn } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { readOptionalString } from "./args.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";

interface Check { kind: "typecheck" | "test" | "build" | "lint" | "check"; command: string }

async function exists(file: string): Promise<boolean> {
  return access(file).then(() => true, () => false);
}

async function detect(cwd: string, mode: string): Promise<Check[]> {
  const checks: Check[] = [];
  const packageFile = path.join(cwd, "package.json");
  if (await exists(packageFile)) {
    try {
      const pkg = JSON.parse(await readFile(packageFile, "utf8")) as { scripts?: Record<string, string> };
      const manager = await exists(path.join(cwd, "pnpm-lock.yaml")) ? "pnpm" : await exists(path.join(cwd, "yarn.lock")) ? "yarn" : "npm";
      const run = (script: string): string => manager === "npm" ? `npm run ${script}` : `${manager} ${script}`;
      const scripts = pkg.scripts ?? {};
      for (const name of ["typecheck", "check"]) if (scripts[name]) { checks.push({ kind: "typecheck", command: run(name) }); break; }
      if (scripts.test && !/no test specified/i.test(scripts.test)) checks.push({ kind: "test", command: manager === "npm" ? "npm test" : `${manager} test` });
      if (mode === "full" && scripts.lint) checks.push({ kind: "lint", command: run("lint") });
      if (mode === "full" && scripts.build) checks.push({ kind: "build", command: run("build") });
    } catch { /* Other ecosystems may still be detected. */ }
  }
  const pythonTests = await readdir(path.join(cwd, "tests")).then((entries) => entries.some((name) => name.endsWith(".py")), () => false);
  if (await exists(path.join(cwd, "pyproject.toml")) || await exists(path.join(cwd, "pytest.ini")) || pythonTests) {
    checks.push({ kind: "test", command: "python -m pytest -q" });
  }
  if (await exists(path.join(cwd, "Cargo.toml"))) {
    checks.push({ kind: "typecheck", command: "cargo check" }, { kind: "test", command: "cargo test" });
  }
  if (await exists(path.join(cwd, "go.mod"))) checks.push({ kind: "test", command: "go test ./..." });
  const hasSolution = await readdir(cwd).then((entries) => entries.some((entry) => entry.toLowerCase().endsWith(".sln")), () => false);
  if (hasSolution) checks.push({ kind: "test", command: "dotnet test" });
  const unique = new Map(checks.map((check) => [check.command, check]));
  return [...unique.values()];
}

async function run(command: string, context: ToolContext): Promise<{ code: number; output: string }> {
  const child = spawn(command, { cwd: context.cwd, shell: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1", NO_COLOR: "1" } });
  let output = "";
  const limit = Math.max(2_000, context.config.tools.maxOutputChars);
  const append = (chunk: Buffer | string): void => { if (output.length < limit) output += String(chunk).slice(0, limit - output.length); };
  child.stdout.on("data", append); child.stderr.on("data", append);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, context.config.tools.commandTimeoutMs);
  const abort = (): void => { child.kill(); }; context.signal.addEventListener("abort", abort, { once: true });
  const code = await new Promise<number>((resolve) => { child.once("error", (error) => { append(error.message); resolve(1); }); child.once("close", (value) => resolve(value ?? 1)); }).finally(() => { clearTimeout(timer); context.signal.removeEventListener("abort", abort); });
  if (context.signal.aborted) throw new Error("Verification aborted.");
  return { code: timedOut ? 124 : code, output: output.trimEnd() || "(no output)" };
}

export const verifyTool: Tool = {
  definition: {
    name: "verify",
    description: "Detect project stack and run its typecheck/tests; full also runs lint/build. Requires command approval.",
    parameters: {
      type: "object",
      properties: { mode: { type: "string", description: "quick: typecheck+tests; full: also lint+build.", enum: ["quick", "full"], default: "quick" } },
      required: [], additionalProperties: false,
    },
    safe: false,
    summary: (input) => `project verification (${typeof input.mode === "string" ? input.mode : "quick"})`,
    example: { mode: "quick" },
  },
  async run(input, context): Promise<ToolResult> {
    const mode = readOptionalString(input, "mode", { trim: true }) || "quick";
    if (!['quick', 'full'].includes(mode)) return { ok: false, output: `Unsupported verify mode: ${mode}.` };
    const checks = await detect(context.cwd, mode);
    if (!checks.length) return { ok: false, output: "No supported project verification was detected. Use full profile and execute_command for a project-specific check." };
    const sections: string[] = [];
    const kinds = new Set<string>();
    let ok = true;
    for (const check of checks) {
      const result = await run(check.command, context);
      sections.push(`## ${check.kind}: ${check.command}\nexit code: ${result.code}\n${result.output}`);
      if (result.code === 0) {
        kinds.add(check.kind === "typecheck" ? "check" : check.kind);
        if (check.kind === "test") kinds.add("test");
        if (check.kind === "build") kinds.add("build");
      } else ok = false;
    }
    return { ok, verificationKinds: [...kinds], changed: false, output: sections.join("\n\n").slice(0, context.config.tools.maxOutputChars) };
  },
};
