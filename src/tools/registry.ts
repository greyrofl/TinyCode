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
import type { Tool, ToolDefinition } from "./types.js";

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

  definitions(): ToolDefinition[] {
    return [...this.tools.values()].map((tool) => tool.definition);
  }

  list(): Tool[] {
    return [...this.tools.values()];
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
    .register(sayTool);
  for (const tool of createProcessTools(processes)) registry.register(tool);
  registry.onDispose(() => processes.dispose());
  return registry;
}
