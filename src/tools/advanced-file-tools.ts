import {
  cp,
  mkdir,
  readFile,
  rename,
  rmdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { readOptionalBoolean, readOptionalInt, readString, readStringArray } from "./args.js";
import { assertRealPathInCwd, relativeDisplay, resolveInCwd } from "./paths.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import { fileChangeFeedback } from "./change-feedback.js";

const MAX_FILE_CHARS = 2_000_000;

function pathArg(input: Record<string, unknown>, key = "path"): string {
  return readString(input, key, { trim: true, allowEmpty: false });
}

async function existingPath(
  context: ToolContext,
  requested: string,
): Promise<{ absolute: string; info: Awaited<ReturnType<typeof stat>> }> {
  const absolute = resolveInCwd(context.cwd, requested);
  const info = await stat(absolute).catch(() => null);
  if (!info) throw new Error(`Path not found: ${requested}.`);
  await assertRealPathInCwd(context.cwd, absolute);
  return { absolute, info };
}

async function missingDestination(context: ToolContext, requested: string): Promise<string> {
  const absolute = resolveInCwd(context.cwd, requested);
  const exists = await stat(absolute).then(
    () => true,
    () => false,
  );
  if (exists) throw new Error(`Destination already exists: ${requested}.`);
  await assertRealPathInCwd(context.cwd, absolute, true);
  return absolute;
}

export const readFilesTool: Tool = {
  definition: {
    name: "read_files",
    description: "Read several UTF-8 text files in one call. Use this after find_files when multiple related files are needed.",
    parameters: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          description: "1-20 file paths relative to the working directory.",
          items: { type: "string", description: "File path." },
        },
        maxCharsPerFile: {
          type: "integer",
          description: "Maximum characters per file. Default: 12000, max: 100000.",
        },
      },
      required: ["paths"],
      additionalProperties: false,
    },
    safe: true,
    summary: (input) => `${Array.isArray(input.paths) ? input.paths.length : 0} files`,
  },
  async run(input, context): Promise<ToolResult> {
    const paths = readStringArray(input, "paths", 1, 20);
    const perFile = readOptionalInt(input, "maxCharsPerFile", 12_000, 500, 100_000);
    const totalLimit = Math.max(1_000, context.config.tools.maxOutputChars);
    const sections: string[] = [];
    let used = 0;

    for (const requested of paths) {
      if (context.signal.aborted) throw new Error("Read aborted.");
      try {
        const { absolute, info } = await existingPath(context, requested);
        if (!info.isFile()) throw new Error("not a file");
        const content = await readFile(absolute, "utf8");
        if (content.includes("\0")) throw new Error("binary file");
        const clipped = content.length > perFile
          ? `${content.slice(0, perFile)}\n… file truncated (${content.length - perFile} chars omitted)`
          : content;
        const section = `===== ${relativeDisplay(context.cwd, absolute)} =====\n${clipped}`;
        if (used + section.length > totalLimit) {
          const remaining = Math.max(0, totalLimit - used);
          if (remaining > 80) sections.push(`${section.slice(0, remaining - 32)}\n… total output limit reached`);
          else sections.push("… total output limit reached");
          break;
        }
        sections.push(section);
        used += section.length;
      } catch (error) {
        const section = `===== ${requested} =====\nError: ${(error as Error).message}`;
        sections.push(section);
        used += section.length;
      }
    }
    return { ok: true, output: sections.join("\n\n") };
  },
};

export const editFileTool: Tool = {
  definition: {
    name: "edit_file",
    description:
      "Make an exact text replacement in an existing file. Fails when oldText is absent or ambiguous unless replaceAll is true.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Existing file path." },
        oldText: { type: "string", description: "Exact text to replace. Must not be empty." },
        newText: { type: "string", description: "Replacement text; may be empty to remove oldText." },
        replaceAll: { type: "boolean", description: "Replace every occurrence. Default: false." },
      },
      required: ["path", "oldText", "newText"],
      additionalProperties: false,
    },
    safe: false,
    summary: (input) => (typeof input.path === "string" ? input.path : "(file)"),
  },
  async run(input, context): Promise<ToolResult> {
    const requested = pathArg(input);
    const oldText = readString(input, "oldText", { allowEmpty: false });
    const newText = readString(input, "newText", { allowEmpty: true });
    if (oldText === newText) return { ok: false, changed: false, output: "No change: oldText and newText are identical. Do not repeat this edit." };
    const replaceAll = readOptionalBoolean(input, "replaceAll", false);
    const { absolute, info } = await existingPath(context, requested);
    if (!info.isFile()) return { ok: false, output: `Not a file: ${requested}.` };
    const content = await readFile(absolute, "utf8");
    if (content.includes("\0")) return { ok: false, output: `Binary file is not supported: ${requested}.` };
    if (content.length > MAX_FILE_CHARS) return { ok: false, output: `File is too large to edit (${content.length} chars).` };

    const occurrences = content.split(oldText).length - 1;
    if (occurrences === 0) {
      return { ok: false, output: `oldText was not found in ${requested}. Read the file again and use an exact match.` };
    }
    if (occurrences > 1 && !replaceAll) {
      return {
        ok: false,
        output: `oldText occurs ${occurrences} times in ${requested}. Provide more context or set replaceAll to true.`,
      };
    }
    const next = replaceAll ? content.split(oldText).join(newText) : content.replace(oldText, newText);
    if (next.length > MAX_FILE_CHARS) return { ok: false, output: `Edited file would exceed ${MAX_FILE_CHARS} chars.` };
    await writeFile(absolute, next, "utf8");
    return {
      ok: true,
      changed: true,
      changedPaths: [absolute],
      output: `Edited ${relativeDisplay(context.cwd, absolute)} (${replaceAll ? occurrences : 1} replacements).\n\n${fileChangeFeedback(requested, content, next)}`,
    };
  },
};

export const fileInfoTool: Tool = {
  definition: {
    name: "file_info",
    description: "Return type, size, timestamps and resolved relative path for a file or directory.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "File or directory path." } },
      required: ["path"],
      additionalProperties: false,
    },
    safe: true,
    summary: (input) => (typeof input.path === "string" ? input.path : "(path)"),
  },
  async run(input, context): Promise<ToolResult> {
    const requested = pathArg(input);
    const { absolute, info } = await existingPath(context, requested);
    const type = info.isFile() ? "file" : info.isDirectory() ? "directory" : "other";
    return {
      ok: true,
      output: [
        `Path: ${relativeDisplay(context.cwd, absolute)}`,
        `Type: ${type}`,
        `Size: ${info.size} bytes`,
        `Modified: ${info.mtime.toISOString()}`,
        `Created: ${info.birthtime.toISOString()}`,
      ].join("\n"),
    };
  },
};

export const makeDirectoryTool: Tool = {
  definition: {
    name: "make_directory",
    description: "Create a directory and missing parent directories inside the working directory.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Directory path." } },
      required: ["path"],
      additionalProperties: false,
    },
    safe: true,
    summary: (input) => (typeof input.path === "string" ? input.path : "(directory)"),
  },
  async run(input, context): Promise<ToolResult> {
    const requested = pathArg(input);
    const absolute = resolveInCwd(context.cwd, requested);
    await assertRealPathInCwd(context.cwd, absolute, true);
    const existed = await stat(absolute).then(() => true, () => false);
    await mkdir(absolute, { recursive: true });
    return { ok: true, changed: !existed, changedPaths: existed ? [] : [absolute], output: `Directory ready: ${relativeDisplay(context.cwd, absolute)}.` };
  },
};

export const movePathTool: Tool = {
  definition: {
    name: "move_path",
    description: "Move or rename a file or directory. The destination must not exist.",
    parameters: {
      type: "object",
      properties: {
        source: { type: "string", description: "Existing source path." },
        destination: { type: "string", description: "New path." },
      },
      required: ["source", "destination"],
      additionalProperties: false,
    },
    safe: false,
    summary: (input) => `${String(input.source ?? "?")} → ${String(input.destination ?? "?")}`,
  },
  async run(input, context): Promise<ToolResult> {
    const sourceName = pathArg(input, "source");
    const destinationName = pathArg(input, "destination");
    const { absolute: source } = await existingPath(context, sourceName);
    const destination = await missingDestination(context, destinationName);
    await mkdir(path.dirname(destination), { recursive: true });
    await rename(source, destination);
    return { ok: true, changed: true, changedPaths: [source, destination], output: `Moved ${sourceName} to ${destinationName}.` };
  },
};

export const copyPathTool: Tool = {
  definition: {
    name: "copy_path",
    description: "Copy a file or directory recursively. The destination must not exist.",
    parameters: {
      type: "object",
      properties: {
        source: { type: "string", description: "Existing source path." },
        destination: { type: "string", description: "New copy path." },
      },
      required: ["source", "destination"],
      additionalProperties: false,
    },
    safe: false,
    summary: (input) => `${String(input.source ?? "?")} → ${String(input.destination ?? "?")}`,
  },
  async run(input, context): Promise<ToolResult> {
    const sourceName = pathArg(input, "source");
    const destinationName = pathArg(input, "destination");
    const { absolute: source } = await existingPath(context, sourceName);
    const destination = await missingDestination(context, destinationName);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(source, destination, { recursive: true, force: false, errorOnExist: true });
    return { ok: true, changed: true, changedPaths: [destination], output: `Copied ${sourceName} to ${destinationName}.` };
  },
};

export const deleteDirectoryTool: Tool = {
  definition: {
    name: "delete_directory",
    description: "Delete a directory. Set recursive=true for a non-empty directory. Cannot delete the working directory itself.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path." },
        recursive: { type: "boolean", description: "Delete all contents. Default: false." },
      },
      required: ["path"],
      additionalProperties: false,
    },
    safe: false,
    summary: (input) => (typeof input.path === "string" ? input.path : "(directory)"),
  },
  async run(input, context): Promise<ToolResult> {
    const requested = pathArg(input);
    const recursive = readOptionalBoolean(input, "recursive", false);
    const { absolute, info } = await existingPath(context, requested);
    if (!info.isDirectory()) return { ok: false, output: `Not a directory: ${requested}.` };
    if (path.resolve(absolute) === path.resolve(context.cwd)) {
      return { ok: false, output: "Refusing to delete the working directory." };
    }
    if (recursive) await rm(absolute, { recursive: true, force: false });
    else await rmdir(absolute);
    return { ok: true, changed: true, changedPaths: [absolute], output: `Deleted directory ${requested}${recursive ? " recursively" : ""}.` };
  },
};
