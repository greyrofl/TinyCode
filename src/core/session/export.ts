import type { Session } from "./types.js";
import { formatCompactNumber } from "../../util/time.js";

/** Serialize a session to a portable Markdown file (used by /export). */
export function sessionToMarkdown(session: Session): string {
  const meta = session.meta;
  const lines: string[] = [
    `# ${meta.title}`,
    "",
    `- Session: \`${meta.id}\``,
    `- Model: \`${meta.model}\``,
    `- Working directory: \`${meta.cwd}\``,
    `- Created: ${new Date(meta.createdAt).toISOString()}`,
    `- Updated: ${new Date(meta.updatedAt).toISOString()}`,
    "",
    "---",
    "",
  ];

  if (meta.compaction?.summary) {
    lines.push(
      "<details>",
      `<summary>Compacted session memory · ${meta.compaction.sourceMessageCount} messages</summary>`,
      "",
      meta.compaction.summary,
      "",
      "</details>",
      "",
      "---",
      "",
    );
  }

  for (const message of session.messages) {
    lines.push(message.role === "user" ? "## You" : `## Assistant${message.model ? ` · ${message.model}` : ""}`);
    lines.push("");

    for (const part of message.parts) {
      if (part.type === "reasoning" && part.text.trim()) {
        lines.push("<details>", "<summary>Thinking</summary>", "", part.text.trim(), "", "</details>", "");
      } else if (part.type === "text" && part.text.trim()) {
        lines.push(part.text.trim(), "");
      } else if (part.type === "steering" && part.text.trim()) {
        lines.push(`### Queued user message`, "", part.text.trim(), "");
      } else if (part.type === "goal_review") {
        lines.push(
          "<details>",
          `<summary>Goal · ${part.verdict === "work_done" ? "work done" : "continue"}</summary>`,
          "",
          part.text.trim(),
          "",
          `Tool: \`${part.tool}\``,
          "",
          "</details>",
          "",
        );
      } else if (part.type === "tool") {
        lines.push(`### Tool · ${part.tool}`, "");
        lines.push(`Status: **${part.status}**${part.title ? ` · ${part.title}` : ""}`, "");
        lines.push("Arguments:", "", "```json", JSON.stringify(part.input, null, 2), "```", "");
        const output = part.error ?? part.output;
        if (output) lines.push("Output:", "", "````text", output, "````", "");
      }
    }
    if (message.error) lines.push(`> Error: ${message.error}`, "");
    if (message.aborted) lines.push("> Aborted", "");
    if (message.usage) {
      const usage = message.usage;
      const requests = usage.modelRequests ? ` · ${usage.modelRequests} model request${usage.modelRequests === 1 ? "" : "s"}` : "";
      const cumulative = usage.modelRequests !== undefined && usage.modelRequests > 1 ? "Σ" : "";
      const speed = usage.tokensPerSecond ? ` · last ${usage.tokensPerSecond.toFixed(1)} tok/s` : "";
      lines.push(
        `<sub>Model traffic${requests} · ${cumulative}${formatCompactNumber(usage.promptTokens)} in · ${cumulative}${formatCompactNumber(
          usage.completionTokens,
        )} out${speed}</sub>`,
        "",
      );
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
