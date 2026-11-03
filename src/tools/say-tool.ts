import { readString } from "./args.js";
import type { Tool, ToolResult } from "./types.js";

export const sayTool: Tool = {
  definition: {
    name: "say",
    description:
      "Send a plain message to the user and finish the current task turn. Use this for progress updates or the final response when you do not need another tool.",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", description: "Message to show to the user." },
      },
      required: ["message"],
      additionalProperties: false,
    },
    safe: true,
    summary: (input) => (typeof input.message === "string" ? input.message : "(message)"),
  },
  async run(input): Promise<ToolResult> {
    const message = readString(input, "message", { allowEmpty: false });
    return {
      ok: true,
      output: "Message delivered to the user.",
      userMessage: message,
      stop: true,
    };
  },
};
