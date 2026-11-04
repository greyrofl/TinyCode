import type { Config } from "../core/config/config.js";

export interface ToolParameterSchema {
  type: "string" | "number" | "integer" | "boolean" | "object" | "array";
  description: string;
  enum?: string[];
  default?: unknown;
  items?: ToolParameterSchema;
  properties?: Record<string, ToolParameterSchema>;
  required?: string[];
}

export interface ToolParameters {
  type: "object";
  properties: Record<string, ToolParameterSchema>;
  required: string[];
  additionalProperties?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameters;
  /** Safe tools run without confirmation. */
  safe: boolean;
  /** Short human-readable summary shown in the transcript and approval dialog. */
  summary(input: Record<string, unknown>): string;
  /** Used in repair feedback and the compact system prompt. */
  example?: Record<string, unknown>;
}

export type ToolProfile = "auto" | "plan" | "edit" | "verify" | "full";
export type ToolTier = "read" | "write" | "verify" | "full" | "always";

export interface ToolContext {
  cwd: string;
  config: Config;
  signal: AbortSignal;
}

export interface ToolResult {
  ok: boolean;
  output: string;
  /** Optional message that should be shown to the user as assistant text. */
  userMessage?: string;
  /** Stop the agent loop after this tool. */
  stop?: boolean;
  /** Actual workspace change, not merely a successful tool invocation. */
  changed?: boolean;
  changedPaths?: string[];
  verificationKinds?: string[];
  /** Files whose contents were actually returned, including partial reads. */
  readPaths?: string[];
}

export interface Tool {
  definition: ToolDefinition;
  run(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}

export interface ToolApprovalRequest {
  tool: string;
  summary: string;
  detail?: string;
}

export type ToolApprovalHandler = (request: ToolApprovalRequest) => Promise<boolean>;
