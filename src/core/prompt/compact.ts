import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "../config/config.js";
import type { SystemPromptInfo } from "./system.js";

const FALLBACK = `# ROLE
Compress an older coding-agent conversation into factual working memory.

# RULES
- Preserve the goal, requirements, file changes, commands, verification, errors, decisions and remaining work.
- Remove repetition, filler, raw thinking and large logs.
- Never invent facts and never emit tool calls.
- Return concise Markdown only.

# FORMAT
## Goal
## Requirements and constraints
## Project and code state
## Changes completed
## Commands and verification
## Decisions
## Errors and blockers
## Remaining work
## Next step
`;

function candidates(config: Config): string[] {
  const files: string[] = [];
  if (config.compaction.promptFile) files.push(path.resolve(process.cwd(), config.compaction.promptFile));
  if (process.env.TINYCODE_COMPACTION_PROMPT?.trim()) {
    files.push(path.resolve(process.cwd(), process.env.TINYCODE_COMPACTION_PROMPT.trim()));
  }
  files.push(fileURLToPath(new URL("../../../compact.md", import.meta.url)));
  return files;
}

export function loadCompactionPrompt(config: Config): SystemPromptInfo {
  for (const file of candidates(config)) {
    try {
      return { text: readFileSync(file, "utf8").trimEnd() + "\n", source: file, usedFallback: false };
    } catch {
      // Try the next path.
    }
  }
  return { text: FALLBACK, source: "built-in", usedFallback: true };
}
