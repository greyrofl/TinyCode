import { readFileSync } from "node:fs";
import path from "node:path";

const FILES = ["AGENTS.md", "TINYCODE.md", "CLAUDE.md", path.join(".tinycode", "instructions.md")];
const MAX_TOTAL_CHARS = 6_000;

export interface ProjectInstructions {
  text: string;
  files: string[];
}

/** Load conventional project-level agent instructions from the session cwd. */
export function loadProjectInstructions(cwd: string): ProjectInstructions {
  const blocks: string[] = [];
  const files: string[] = [];
  let remaining = MAX_TOTAL_CHARS;

  for (const relative of FILES) {
    if (remaining <= 0) break;
    const absolute = path.join(cwd, relative);
    try {
      const content = readFileSync(absolute, "utf8").trim();
      if (!content) continue;
      const clipped = content.length > remaining
        ? `${content.slice(0, Math.max(0, remaining - 28))}\n… instructions truncated`
        : content;
      blocks.push(`<project_instruction file="${relative.split(path.sep).join("/")}">\n${clipped}\n</project_instruction>`);
      files.push(relative);
      remaining -= clipped.length;
    } catch {
      // Optional file does not exist or is unreadable.
    }
  }

  if (blocks.length === 0) return { text: "", files: [] };
  return {
    text: [
      "# PROJECT INSTRUCTIONS",
      "Follow these project-specific instructions unless they conflict with the system prompt or the current user request.",
      ...blocks,
    ].join("\n\n"),
    files,
  };
}
