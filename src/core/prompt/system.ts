import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "../config/config.js";
import type { ToolDefinition } from "../../tools/types.js";

export interface SystemPromptInfo {
  text: string;
  /** File that was loaded, or "built-in" when the fallback is used. */
  source: string;
  usedFallback: boolean;
}

function toolBlock(tools: ToolDefinition[]): string {
  if (tools.length === 0) return "No tools are available.";
  return tools
    .map((tool) => {
      const approval = tool.safe ? "automatic" : "user approval required";
      const required = new Set(tool.parameters.required);
      const parameters = Object.entries(tool.parameters.properties).map(([name, schema]) => {
        const type = schema.type === "array" && schema.items ? `${schema.items.type}[]` : schema.type;
        return `${name}:${type}${required.has(name) ? "!" : "?"}`;
      });
      return [
        `### ${tool.name} [${approval}]`,
        tool.description,
        parameters.length > 0 ? `Arguments: ${parameters.join("; ")}` : "Arguments: none",
      ].join("\n");
    })
    .join("\n\n");
}

const PROTOCOL = [
  "# TOOL CALL FORMAT",
  "",
  "To use a tool, output exactly one block:",
  "",
  "<tool_call>",
  '{"name": "tool_name", "arguments": {"key": "value"}}',
  "</tool_call>",
  "",
  "Rules:",
  "- Call exactly ONE tool per assistant turn.",
  "- Do not wrap the block in Markdown code fences.",
  "- Wait for the tool result, which arrives as a message starting with `[Observation:`.",
  "- Never invent a tool or an argument that is not listed above.",
  "- Paths are relative to the working directory unless stated otherwise.",
  "- When the task is complete, write a concise final answer as plain text. Do not use a tool call for the final answer.",
].join("\n");

function fallbackPrompt(tools: ToolDefinition[]): string {
  return [
    "# ROLE",
    "You are TinyCode, a precise coding agent running locally on the user's machine.",
    "",
    "Working directory: `{{CWD}}`",
    "",
    "# PROTOCOL",
    "1. Analyze the request briefly.",
    "2. Call exactly one tool.",
    "3. Wait for the observation.",
    "4. Repeat until the task is verified, then write the final answer.",
    "",
    "# AVAILABLE TOOLS",
    toolBlock(tools),
    "",
    PROTOCOL,
  ].join("\n");
}

function resolveCandidates(config: Config): string[] {
  const candidates: string[] = [];
  if (config.tools.promptFile) candidates.push(path.resolve(process.cwd(), config.tools.promptFile));
  if (process.env.TINYCODE_PROMPT?.trim()) {
    candidates.push(path.resolve(process.cwd(), process.env.TINYCODE_PROMPT.trim()));
  }
  candidates.push(fileURLToPath(new URL("../../../promt.md", import.meta.url)));
  candidates.push(fileURLToPath(new URL("../../../prompt.md", import.meta.url)));
  return candidates;
}

function inject(template: string, tools: ToolDefinition[]): string {
  const definitions = toolBlock(tools);
  let text = template;

  if (/<!--\s*TOOL DEFINITIONS PLACEHOLDER\s*-->/i.test(text)) {
    text = text.replace(/<!--\s*TOOL DEFINITIONS PLACEHOLDER\s*-->/i, definitions);
  } else if (!text.includes("### create_file") && !text.includes("### read_file")) {
    text = `${text.trimEnd()}\n\n# AVAILABLE TOOLS\n\n${definitions}\n`;
  }

  if (!text.includes("<tool_call>")) {
    text = `${text.trimEnd()}\n\n${PROTOCOL}\n`;
  }

  text = text.replaceAll("{{TOOLS}}", definitions);
  return text.trimEnd() + "\n";
}

/**
 * Load the agent system prompt. The repository ships `promt.md`; the tool
 * definitions are injected so the prompt and registry cannot drift apart.
 */
export function loadSystemPrompt(tools: ToolDefinition[], config: Config): SystemPromptInfo {
  for (const file of resolveCandidates(config)) {
    try {
      const template = readFileSync(file, "utf8");
      return { text: inject(template, tools), source: file, usedFallback: false };
    } catch {
      // Try the next candidate.
    }
  }
  return {
    text: inject(fallbackPrompt(tools), tools),
    source: "built-in",
    usedFallback: true,
  };
}
