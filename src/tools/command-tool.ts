import { spawn } from "node:child_process";
import { readOptionalInt, readString } from "./args.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import { workspaceStamp } from "./change-feedback.js";

const MAX_TIMEOUT_MS = 600_000;

function killTree(child: ReturnType<typeof spawn>): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    }).unref();
  } else {
    child.kill("SIGTERM");
  }
}

export const executeCommandTool: Tool = {
  definition: {
    name: "execute_command",
    description:
      "Run a shell command in the working directory and return its exit code and output. Use non-interactive commands only. Requires approval.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute." },
        timeoutMs: {
          type: "integer",
          description: "Optional timeout in milliseconds (default from config, max 600000).",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
    safe: false,
    summary: (input) => (typeof input.command === "string" ? input.command : "(command)"),
  },
  async run(input, context): Promise<ToolResult> {
    if (context.signal.aborted) throw new Error("Command aborted.");
    const command = readString(input, "command", { trim: true, allowEmpty: false });
    const configured = context.config.tools.commandTimeoutMs;
    const timeoutMs = Math.min(
      MAX_TIMEOUT_MS,
      readOptionalInt(input, "timeoutMs", configured, 1_000, MAX_TIMEOUT_MS),
    );
    const maxOutput = Math.max(1_000, context.config.tools.maxOutputChars);
    const before = await workspaceStamp(context.cwd);

    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, {
        cwd: context.cwd,
        shell: true,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          CI: "1",
          NO_COLOR: "1",
          GIT_PAGER: "cat",
          PAGER: "cat",
          TERM: process.env.TERM ?? "dumb",
        },
      });
    } catch (error) {
      return { ok: false, output: `Failed to start command: ${(error as Error).message}` };
    }

    const append = (target: "stdout" | "stderr", chunk: string): void => {
      if (target === "stdout") {
        if (stdout.length >= maxOutput) {
          truncated = true;
          return;
        }
        stdout += chunk.slice(0, maxOutput - stdout.length);
        if (stdout.length >= maxOutput) truncated = true;
      } else {
        if (stderr.length >= maxOutput) {
          truncated = true;
          return;
        }
        stderr += chunk.slice(0, maxOutput - stderr.length);
        if (stderr.length >= maxOutput) truncated = true;
      }
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => append("stdout", chunk));
    child.stderr?.on("data", (chunk: string) => append("stderr", chunk));

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);

    const onAbort = (): void => killTree(child);
    context.signal.addEventListener("abort", onAbort, { once: true });

    const exitCode = await new Promise<number>((resolve) => {
      child.once("error", () => resolve(1));
      child.once("close", (code) => resolve(code ?? 1));
    }).finally(() => {
      clearTimeout(timer);
      context.signal.removeEventListener("abort", onAbort);
    });

    if (context.signal.aborted) throw new Error("Command aborted.");

    const sections: string[] = [`$ ${command}`, `exit code: ${timedOut ? "timeout" : exitCode}`];
    if (stdout.trim()) sections.push(stdout.trimEnd());
    if (stderr.trim()) sections.push(`stderr:\n${stderr.trimEnd()}`);
    if (!stdout.trim() && !stderr.trim()) sections.push("(no output)");
    if (truncated) sections.push(`… output truncated at ${maxOutput} characters`);
    if (timedOut) sections.push(`Command timed out after ${timeoutMs} ms.`);

    const after = await workspaceStamp(context.cwd);
    return {
      ok: !timedOut && exitCode === 0,
      changed: before !== null && after !== null ? before !== after : undefined,
      output: sections.join("\n\n"),
    };
  },
};
