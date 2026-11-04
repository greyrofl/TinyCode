import type { Config } from "../core/config/config.js";
import type { ToolRegistry } from "../tools/registry.js";
import { McpClient } from "./client.js";

export interface McpConnectionResult { connected: string[]; errors: string[] }

export async function attachMcpTools(registry: ToolRegistry, config: Config, cwd: string): Promise<McpConnectionResult> {
  const connected: string[] = [];
  const errors: string[] = [];
  if (!config.mcp.enabled) return { connected, errors };
  for (const [name, server] of Object.entries(config.mcp.servers)) {
    if (!server.enabled) continue;
    const client = new McpClient(name, server, cwd);
    try {
      const tools = await client.connect();
      for (const tool of tools) registry.register(tool);
      registry.onDispose(() => client.dispose());
      connected.push(`${name} (${tools.length} tools)`);
    } catch (error) {
      client.dispose();
      errors.push(`${name}: ${(error as Error).message}`);
    }
  }
  return { connected, errors };
}
