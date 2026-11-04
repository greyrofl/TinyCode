import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readOptionalInt, readOptionalString, readString } from "./args.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";

type ProcessState = "running" | "exited" | "stopped" | "error";

interface ManagedProcess {
  id: string;
  name: string;
  command: string;
  child: ChildProcessWithoutNullStreams;
  state: ProcessState;
  exitCode: number | null;
  startedAt: number;
  endedAt?: number;
  output: string;
  maxOutput: number;
}

function killTree(child: ChildProcessWithoutNullStreams): void {
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

function tailLines(text: string, count: number): string {
  return text.split(/\r?\n/).slice(-count).join("\n");
}

export class ProcessManager {
  private readonly processes = new Map<string, ManagedProcess>();

  start(command: string, name: string, context: ToolContext): ManagedProcess {
    if (context.signal.aborted) throw new Error("Process start aborted.");
    const child = spawn(command, {
      cwd: context.cwd,
      shell: true,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        NO_COLOR: "1",
        GIT_PAGER: "cat",
        PAGER: "cat",
      },
    });
    child.stdin.end();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const id = `proc_${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
    const item: ManagedProcess = {
      id,
      name,
      command,
      child,
      state: "running",
      exitCode: null,
      startedAt: Date.now(),
      output: "",
      maxOutput: Math.max(4_000, context.config.tools.maxOutputChars * 2),
    };
    this.processes.set(id, item);

    const append = (prefix: string, chunk: string): void => {
      item.output += prefix + chunk;
      if (item.output.length > item.maxOutput) {
        item.output = `… older output discarded\n${item.output.slice(-item.maxOutput)}`;
      }
    };
    child.stdout.on("data", (chunk: string) => append("", chunk));
    child.stderr.on("data", (chunk: string) => append("[stderr] ", chunk));
    child.once("error", (error) => {
      item.state = "error";
      item.endedAt = Date.now();
      append("[error] ", error.message);
    });
    child.once("close", (code) => {
      if (item.state === "running") item.state = "exited";
      item.exitCode = code;
      item.endedAt = Date.now();
    });
    return item;
  }

  get(id: string): ManagedProcess | undefined {
    return this.processes.get(id);
  }

  list(): ManagedProcess[] {
    return [...this.processes.values()];
  }

  async stop(id: string): Promise<ManagedProcess | undefined> {
    const item = this.processes.get(id);
    if (!item) return undefined;
    if (item.state === "running") {
      item.state = "stopped";
      item.endedAt = Date.now();
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(finish, 3_000);
        item.child.once("close", finish);
        killTree(item.child);
      });
    }
    return item;
  }

  dispose(): void {
    for (const item of this.processes.values()) {
      if (item.state === "running") killTree(item.child);
    }
    this.processes.clear();
  }
}

function describe(item: ManagedProcess, lines = 80): string {
  return [
    `ID: ${item.id}`,
    `Name: ${item.name}`,
    `State: ${item.state}`,
    `PID: ${item.child.pid ?? "unknown"}`,
    `Exit code: ${item.exitCode ?? "-"}`,
    `Command: ${item.command}`,
    "",
    tailLines(item.output, lines) || "(no output yet)",
  ].join("\n");
}

export function createProcessTools(manager: ProcessManager): Tool[] {
  const startProcess: Tool = {
    definition: {
      name: "start_process",
      description:
        "Start a managed background process such as a dev server. Returns an id for process_status/stop_process. The process is stopped when TinyCode exits.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Non-interactive command to start." },
          name: { type: "string", description: "Optional short display name." },
        },
        required: ["command"],
        additionalProperties: false,
      },
      safe: false,
      summary: (input) => (typeof input.command === "string" ? input.command : "(process)"),
    },
    async run(input, context): Promise<ToolResult> {
      const command = readString(input, "command", { trim: true, allowEmpty: false });
      const name = readOptionalString(input, "name", { trim: true }) || command.slice(0, 40);
      const item = manager.start(command, name, context);
      return { ok: true, output: `Started ${item.id} (PID ${item.child.pid ?? "unknown"}): ${name}` };
    },
  };

  const processStatus: Tool = {
    definition: {
      name: "process_status",
      description: "Read status and recent output from a managed background process.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Process id returned by start_process." },
          lines: { type: "integer", description: "Recent output lines (max 500).", default: 80 },
        },
        required: ["id"],
        additionalProperties: false,
      },
      safe: true,
      summary: (input) => String(input.id ?? "(process)"),
    },
    async run(input): Promise<ToolResult> {
      const id = readString(input, "id", { trim: true, allowEmpty: false });
      const lines = readOptionalInt(input, "lines", 80, 1, 500);
      const item = manager.get(id);
      return item
        ? { ok: true, output: describe(item, lines) }
        : { ok: false, output: `Unknown managed process: ${id}.` };
    },
  };

  const listProcesses: Tool = {
    definition: {
      name: "list_processes",
      description: "List background processes started by TinyCode in this run.",
      parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
      safe: true,
      summary: () => "managed processes",
    },
    async run(): Promise<ToolResult> {
      const items = manager.list();
      return {
        ok: true,
        output: items.length
          ? items.map((item) => `${item.id} · ${item.state} · ${item.name}`).join("\n")
          : "(no managed processes)",
      };
    },
  };

  const stopProcess: Tool = {
    definition: {
      name: "stop_process",
      description: "Stop one managed background process and its child process tree.",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "Process id returned by start_process." } },
        required: ["id"],
        additionalProperties: false,
      },
      safe: false,
      summary: (input) => String(input.id ?? "(process)"),
    },
    async run(input): Promise<ToolResult> {
      const id = readString(input, "id", { trim: true, allowEmpty: false });
      const item = await manager.stop(id);
      return item
        ? { ok: true, output: `Stopped ${id} (${item.name}).` }
        : { ok: false, output: `Unknown managed process: ${id}.` };
    },
  };

  return [startProcess, processStatus, listProcesses, stopProcess];
}
