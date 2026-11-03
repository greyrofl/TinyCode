import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { readOptionalInt, readString } from "./args.js";
import { assertRealPathInCwd, relativeDisplay, resolveInCwd } from "./paths.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import { fileChangeFeedback } from "./change-feedback.js";

const MAX_WRITE_CHARS = 2_000_000;

function pathArgument(input: Record<string, unknown>): string {
  return readString(input, "path", { trim: true, allowEmpty: false });
}

function outputLimit(context: ToolContext): number {
  return Math.max(1_000, context.config.tools.maxOutputChars);
}

function truncateOutput(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n… output truncated (${text.length - limit} more characters)`;
}

export const createFileTool: Tool = {
  definition: {
    name: "create_file",
    description:
      "Create a new file with the given content. Parent directories are created automatically. Fails if the file already exists; use replace_file to overwrite.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the working directory." },
        content: { type: "string", description: "Complete file content." },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    safe: true,
    summary: (input) => (typeof input.path === "string" ? input.path : "(new file)"),
  },
  async run(input, context): Promise<ToolResult> {
    const requested = pathArgument(input);
    const content = readString(input, "content", { allowEmpty: true });
    if (content.length > MAX_WRITE_CHARS) {
      return { ok: false, output: `Refusing to write ${content.length} characters (limit ${MAX_WRITE_CHARS}).` };
    }

    const file = resolveInCwd(context.cwd, requested);
    await assertRealPathInCwd(context.cwd, file, true);
    await mkdir(path.dirname(file), { recursive: true });
    try {
      await writeFile(file, content, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return { ok: false, output: `File already exists: ${requested}. Read it and use replace_file.` };
      }
      throw error;
    }
    return {
      ok: true,
      changed: true,
      changedPaths: [file],
      output: `Created ${relativeDisplay(context.cwd, file)} (${content.length} chars).`,
    };
  },
};

export const replaceFileTool: Tool = {
  definition: {
    name: "replace_file",
    description:
      "Replace the complete contents of an existing file. Read the file first. This is not a partial edit: the entire file is overwritten.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Existing file path relative to the working directory." },
        content: { type: "string", description: "New complete file content." },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    safe: false,
    summary: (input) => (typeof input.path === "string" ? input.path : "(file)"),
  },
  async run(input, context): Promise<ToolResult> {
    const requested = pathArgument(input);
    const content = readString(input, "content", { allowEmpty: true });
    if (content.length > MAX_WRITE_CHARS) {
      return { ok: false, output: `Refusing to write ${content.length} characters (limit ${MAX_WRITE_CHARS}).` };
    }

    const file = resolveInCwd(context.cwd, requested);
    const info = await stat(file).catch(() => null);
    if (!info) return { ok: false, output: `File not found: ${requested}. Use create_file.` };
    if (!info.isFile()) return { ok: false, output: `Not a file: ${requested}.` };
    await assertRealPathInCwd(context.cwd, file);
    const previous = await readFile(file, "utf8");
    if (previous === content) return { ok: false, changed: false, output: "No change: this file already has the supplied content." };
    await writeFile(file, content, "utf8");
    return {
      ok: true,
      changed: true,
      changedPaths: [file],
      output: `Replaced ${relativeDisplay(context.cwd, file)} (${content.length} chars).\n\n${fileChangeFeedback(requested, previous, content)}`,
    };
  },
};

export const deleteFileTool: Tool = {
  definition: {
    name: "delete_file",
    description: "Delete a single file. Directories are not deleted. Requires approval.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the working directory." },
      },
      required: ["path"],
      additionalProperties: false,
    },
    safe: false,
    summary: (input) => (typeof input.path === "string" ? input.path : "(file)"),
  },
  async run(input, context): Promise<ToolResult> {
    const requested = pathArgument(input);
    const file = resolveInCwd(context.cwd, requested);
    const info = await stat(file).catch(() => null);
    if (!info) return { ok: false, output: `File not found: ${requested}.` };
    if (!info.isFile()) return { ok: false, output: `Not a file: ${requested}. Directories are not deleted.` };
    await assertRealPathInCwd(context.cwd, file);
    await rm(file);
    return { ok: true, changed: true, changedPaths: [file], output: `Deleted ${relativeDisplay(context.cwd, file)}.` };
  },
};

export const readFileTool: Tool = {
  definition: {
    name: "read_file",
    description:
      "Read a UTF-8 text file. Returns the complete content, or a line range when offset/limit are provided.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the working directory." },
        offset: { type: "integer", description: "First line to read (1-based). Default: 1." },
        limit: { type: "integer", description: "Maximum number of lines. Default: 400, max: 2000." },
      },
      required: ["path"],
      additionalProperties: false,
    },
    safe: true,
    summary: (input) => (typeof input.path === "string" ? input.path : "(file)"),
  },
  async run(input, context): Promise<ToolResult> {
    const requested = pathArgument(input);
    const file = resolveInCwd(context.cwd, requested);
    const info = await stat(file).catch(() => null);
    if (!info) return { ok: false, output: `File not found: ${requested}.` };
    if (!info.isFile()) return { ok: false, output: `Not a file: ${requested}.` };
    await assertRealPathInCwd(context.cwd, file);

    const content = await readFile(file, "utf8");
    if (content.includes("\0")) return { ok: false, output: `Binary file is not supported: ${requested}.` };

    const lines = content.split(/\r?\n/);
    const total = lines.length;
    const offset = readOptionalInt(input, "offset", 1, 1, Math.max(1, total));
    const limit = readOptionalInt(input, "limit", 400, 1, 2_000);
    const start = Math.min(offset, total);
    const selected = lines.slice(start - 1, start - 1 + limit);
    const end = Math.min(total, start - 1 + selected.length);

    const header = `File: ${relativeDisplay(context.cwd, file)} (lines ${start}-${end} of ${total})`;
    const body = selected.join("\n");
    return {
      ok: true,
      output: truncateOutput(`${header}\n\n${body}`, outputLimit(context)),
    };
  },
};

export const listDirTool: Tool = {
  definition: {
    name: "list_dir",
    description: "List files and directories at a path. Directories end with a slash.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path relative to the working directory. Default: ." },
      },
      required: [],
      additionalProperties: false,
    },
    safe: true,
    summary: (input) => (typeof input.path === "string" ? input.path : "."),
  },
  async run(input, context): Promise<ToolResult> {
    const requested = typeof input.path === "string" && input.path.trim() ? input.path : ".";
    const dir = resolveInCwd(context.cwd, requested);
    const info = await stat(dir).catch(() => null);
    if (!info) return { ok: false, output: `Directory not found: ${requested}.` };
    if (!info.isDirectory()) return { ok: false, output: `Not a directory: ${requested}.` };
    await assertRealPathInCwd(context.cwd, dir);

    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    const limit = 300;
    const visible = entries.slice(0, limit);
    const lines = visible.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
    const suffix = entries.length > limit ? `\n… ${entries.length - limit} more entries` : "";
    return {
      ok: true,
      output: truncateOutput(
        `Directory: ${relativeDisplay(context.cwd, dir)}\n${lines.length ? lines.join("\n") : "(empty)"}${suffix}`,
        outputLimit(context),
      ),
    };
  },
};
