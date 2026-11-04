import { executeCommandTool } from "./command-tool.js";
import {
  copyPathTool,
  deleteDirectoryTool,
  editFileTool,
  fileInfoTool,
  makeDirectoryTool,
  movePathTool,
  readFilesTool,
} from "./advanced-file-tools.js";
import { fetchUrlTool } from "./fetch-tool.js";
import { createFileTool, deleteFileTool, listDirTool, readFileTool, replaceFileTool } from "./file-tools.js";
import { gitDiffTool, gitLogTool, gitShowTool, gitStatusTool } from "./git-tools.js";
import { applyPatchTool } from "./patch-tool.js";
import { createProcessTools, ProcessManager } from "./process-tools.js";
import { sayTool } from "./say-tool.js";
import { findFilesTool, searchTextTool } from "./search-tools.js";
import { verifyTool } from "./verify-tool.js";
import { diagnosticsTool } from "./lsp-tool.js";
import type { Tool, ToolDefinition, ToolProfile, ToolTier } from "./types.js";

const READ = new Set(["read_file", "read_files", "list_dir", "find_files", "search_text", "file_info", "git_status", "git_diff", "git_log", "git_show", "diagnostics"]);
const WRITE = new Set(["create_file", "replace_file", "edit_file", "apply_patch", "make_directory", "move_path", "copy_path", "delete_file", "delete_directory"]);
const VERIFY = new Set(["verify"]);
const ALWAYS = new Set(["say"]);

export function toolTier(name: string): ToolTier {
  return READ.has(name) ? "read" : WRITE.has(name) ? "write" : VERIFY.has(name) ? "verify" : ALWAYS.has(name) ? "always" : "full";
}

export function profileAllows(profile: ToolProfile, name: string): boolean {
  const tier = toolTier(name);
  if (profile === "full") return true;
  if (tier === "always" || tier === "read") return true;
  if (profile === "plan") return false;
  return tier === "write" || tier === "verify";
}

export type AutoToolStage = "plan" | "edit" | "verify" | "full";

export function stageAllows(configured: ToolProfile, stage: AutoToolStage, name: string): boolean {
  if (configured !== "auto") return profileAllows(configured, name);
  const tier = toolTier(name);
  if (stage === "full") return true;
  if (tier === "always" || tier === "read") return true;
  // Test-first verify is available in automatic plan mode; arbitrary shell is not.
  if (tier === "verify") return true;
  return stage === "edit" || stage === "verify" ? tier === "write" : false;
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();
  private readonly disposers: Array<() => void> = [];

  register(tool: Tool): this {
    this.tools.set(tool.definition.name, tool);
    return this;
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  definitions(profile: ToolProfile = "full"): ToolDefinition[] {
    const effective = profile === "auto" ? "plan" : profile;
    return [...this.tools.values()].filter((tool) => profileAllows(effective, tool.definition.name)).map((tool) => tool.definition);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  isAllowed(profile: ToolProfile, name: string): boolean {
    return profileAllows(profile === "auto" ? "plan" : profile, name);
  }

  definitionsFor(configured: ToolProfile, stage: AutoToolStage): ToolDefinition[] {
    return [...this.tools.values()].filter((tool) => stageAllows(configured, stage, tool.definition.name)).map((tool) => tool.definition);
  }

  isAllowedFor(configured: ToolProfile, stage: AutoToolStage, name: string): boolean {
    return stageAllows(configured, stage, name);
  }

  definition(name: string): ToolDefinition | undefined {
    return this.tools.get(name)?.definition;
  }

  get size(): number {
    return this.tools.size;
  }

  onDispose(disposer: () => void): this {
    this.disposers.push(disposer);
    return this;
  }

  dispose(): void {
    for (const disposer of this.disposers.splice(0)) disposer();
  }
}

export function createDefaultTools(): ToolRegistry {
  const processes = new ProcessManager();
  const registry = new ToolRegistry()
    .register(createFileTool)
    .register(replaceFileTool)
    .register(deleteFileTool)
    .register(readFileTool)
    .register(readFilesTool)
    .register(listDirTool)
    .register(findFilesTool)
    .register(searchTextTool)
    .register(fileInfoTool)
    .register(makeDirectoryTool)
    .register(editFileTool)
    .register(applyPatchTool)
    .register(movePathTool)
    .register(copyPathTool)
    .register(deleteDirectoryTool)
    .register(gitStatusTool)
    .register(gitDiffTool)
    .register(gitLogTool)
    .register(gitShowTool)
    .register(fetchUrlTool)
    .register(executeCommandTool)
    .register(verifyTool)
    .register(diagnosticsTool)
    .register(sayTool);
  for (const tool of createProcessTools(processes)) registry.register(tool);
  registry.onDispose(() => processes.dispose());
  return registry;
}
