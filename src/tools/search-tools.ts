import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { readOptionalBoolean, readOptionalInt, readOptionalString, readString } from "./args.js";
import { assertRealPathInCwd, relativeDisplay, resolveInCwd } from "./paths.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";

const DEFAULT_IGNORED = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".nuxt",
  "coverage",
  ".cache",
]);
const MAX_WALK_ENTRIES = 30_000;
const MAX_SEARCH_FILE_BYTES = 1_500_000;

function slash(value: string): string {
  return value.split(path.sep).join("/");
}

/** Small, dependency-free glob subset: **, *, and ?. */
function globRegex(pattern: string): RegExp {
  const normalized = slash(pattern.trim() || "**/*").replace(/^\.\//, "");
  let source = "^";
  for (let index = 0; index < normalized.length; index++) {
    const char = normalized[index]!;
    if (char === "*") {
      if (normalized[index + 1] === "*") {
        index++;
        if (normalized[index + 1] === "/") {
          index++;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[\\^$+?.()|{}\[\]]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`);
}

interface WalkOptions {
  includeHidden: boolean;
  includeIgnored: boolean;
  signal: AbortSignal;
}

async function walkFiles(root: string, options: WalkOptions): Promise<string[]> {
  const files: string[] = [];
  const queue = [root];
  let visited = 0;

  while (queue.length > 0) {
    if (options.signal.aborted) throw new Error("Search aborted.");
    const current = queue.shift()!;
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (++visited > MAX_WALK_ENTRIES) return files;
      if (!options.includeHidden && entry.name.startsWith(".")) continue;
      if (!options.includeIgnored && DEFAULT_IGNORED.has(entry.name)) continue;
      if (entry.isSymbolicLink()) continue;

      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) queue.push(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  }
  return files;
}

function outputLimit(context: ToolContext): number {
  return Math.max(1_000, context.config.tools.maxOutputChars);
}

function limitText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… output truncated`;
}

export const findFilesTool: Tool = {
  definition: {
    name: "find_files",
    description:
      "Find files with relative globs. Use **/*.test.js for nested tests; *.test.js matches only the search directory. Generated directories are ignored.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob relative to path, for example src/**/*.ts. Default: **/*" },
        path: { type: "string", description: "Directory to search from. Default: ." },
        maxResults: { type: "integer", description: "Maximum results. Default: 200, max: 1000." },
        includeHidden: { type: "boolean", description: "Include dot files/directories. Default: false." },
        includeIgnored: {
          type: "boolean",
          description: "Include node_modules, dist, build, .git and similar directories. Default: false.",
        },
      },
      required: [],
      additionalProperties: false,
    },
    safe: true,
    summary: (input) => `${typeof input.pattern === "string" ? input.pattern : "**/*"} in ${typeof input.path === "string" ? input.path : "."}`,
  },
  async run(input, context): Promise<ToolResult> {
    const requested = readOptionalString(input, "path", { trim: true }) || ".";
    const pattern = readOptionalString(input, "pattern", { trim: true }) || "**/*";
    const maxResults = readOptionalInt(input, "maxResults", 200, 1, 1_000);
    const includeHidden = readOptionalBoolean(input, "includeHidden", false);
    const includeIgnored = readOptionalBoolean(input, "includeIgnored", false);
    const root = resolveInCwd(context.cwd, requested);
    const info = await stat(root).catch(() => null);
    if (!info) return { ok: false, output: `Directory not found: ${requested}.` };
    if (!info.isDirectory()) return { ok: false, output: `Not a directory: ${requested}.` };
    await assertRealPathInCwd(context.cwd, root);

    let matcher: RegExp;
    try {
      matcher = globRegex(pattern);
    } catch (error) {
      return { ok: false, output: `Invalid glob: ${(error as Error).message}` };
    }

    const all = await walkFiles(root, { includeHidden, includeIgnored, signal: context.signal });
    const matches = all
      .map((file) => slash(path.relative(root, file)))
      .filter((file) => matcher.test(file))
      .slice(0, maxResults);
    const more = all.filter((file) => matcher.test(slash(path.relative(root, file)))).length - matches.length;
    const header = `Files matching ${pattern} in ${relativeDisplay(context.cwd, root)}:`;
    const body = matches.length > 0 ? matches.join("\n") : `(no matches)${!pattern.includes("/") ? `\nFor recursive matching try **/${pattern}.` : ""}`;
    const suffix = more > 0 ? `\n… ${more} more matches` : "";
    return { ok: true, output: limitText(`${header}\n${body}${suffix}`, outputLimit(context)) };
  },
};

export const searchTextTool: Tool = {
  definition: {
    name: "search_text",
    description:
      "Search literal text in a file or directory; set regex=true for regular expressions. Returns path:line: content. Generated/binary/large files are skipped.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Literal text or regular expression to search for." },
        path: { type: "string", description: "Directory to search from. Default: ." },
        include: { type: "string", description: "Optional glob for files, for example **/*.ts." },
        regex: { type: "boolean", description: "Treat query as a regular expression. Default: false." },
        caseSensitive: { type: "boolean", description: "Case-sensitive matching. Default: false." },
        maxResults: { type: "integer", description: "Maximum matching lines. Default: 100, max: 500." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    safe: true,
    summary: (input) => `“${typeof input.query === "string" ? input.query : ""}” in ${typeof input.path === "string" ? input.path : "."}`,
  },
  async run(input, context): Promise<ToolResult> {
    const query = readString(input, "query", { allowEmpty: false });
    const requested = readOptionalString(input, "path", { trim: true }) || ".";
    const include = readOptionalString(input, "include", { trim: true });
    const regex = readOptionalBoolean(input, "regex", false);
    const caseSensitive = readOptionalBoolean(input, "caseSensitive", false);
    const maxResults = readOptionalInt(input, "maxResults", 100, 1, 500);
    const root = resolveInCwd(context.cwd, requested);
    const info = await stat(root).catch(() => null);
    if (!info) return { ok: false, output: `Directory not found: ${requested}.` };
    if (!info.isDirectory() && !info.isFile()) return { ok: false, output: `Not a file or directory: ${requested}.` };
    await assertRealPathInCwd(context.cwd, root);

    let matcher: RegExp | null = null;
    if (regex) {
      try {
        matcher = new RegExp(query, caseSensitive ? "" : "i");
      } catch (error) {
        return { ok: false, output: `Invalid regular expression: ${(error as Error).message}` };
      }
    }
    const includeMatcher = include ? globRegex(include) : null;
    const literal = caseSensitive ? query : query.toLowerCase();
    const searchRoot = info.isFile() ? path.dirname(root) : root;
    const files = info.isFile() ? [root] : await walkFiles(root, {
      includeHidden: false,
      includeIgnored: false,
      signal: context.signal,
    });
    const results: string[] = [];
    let skippedLarge = 0;

    for (const file of files) {
      if (context.signal.aborted) throw new Error("Search aborted.");
      const relative = slash(path.relative(searchRoot, file));
      if (includeMatcher && !includeMatcher.test(relative)) continue;
      const fileInfo = await stat(file);
      if (fileInfo.size > MAX_SEARCH_FILE_BYTES) {
        skippedLarge++;
        continue;
      }
      const content = await readFile(file, "utf8").catch(() => null);
      if (content === null || content.includes("\0")) continue;

      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index]!;
        const match = matcher ? matcher.test(line) : (caseSensitive ? line : line.toLowerCase()).includes(literal);
        if (!match) continue;
        const preview = line.trim().slice(0, 300);
        results.push(`${relative}:${index + 1}: ${preview}`);
        if (results.length >= maxResults) break;
      }
      if (results.length >= maxResults) break;
    }

    const header = `Matches for ${JSON.stringify(query)} in ${relativeDisplay(context.cwd, root)}:`;
    const body = results.length > 0 ? results.join("\n") : "(no matches)";
    const notes = [
      results.length >= maxResults ? `result limit reached (${maxResults})` : "",
      skippedLarge > 0 ? `${skippedLarge} large files skipped` : "",
    ].filter(Boolean);
    return {
      ok: true,
      output: limitText(`${header}\n${body}${notes.length ? `\n… ${notes.join("; ")}` : ""}`, outputLimit(context)),
    };
  },
};
