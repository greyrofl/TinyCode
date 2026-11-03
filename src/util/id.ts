import { randomBytes } from "node:crypto";

function compactRandom(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

export function newSessionId(): string {
  return `ses_${Date.now().toString(36)}${compactRandom(3)}`;
}

export function newMessageId(role: "user" | "assistant"): string {
  return `msg_${role}_${Date.now().toString(36)}${compactRandom(2)}`;
}

export function newNoticeId(): string {
  return `note_${Date.now().toString(36)}${compactRandom(2)}`;
}

export function newToolCallId(): string {
  return `call_${Date.now().toString(36)}${compactRandom(3)}`;
}
