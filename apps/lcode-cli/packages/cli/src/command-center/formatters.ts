import type { CommandCenterApp } from "./types.js";

export function formatResumeResult(
  sessionId: string,
  result: Awaited<ReturnType<CommandCenterApp["resume"]>>,
): string {
  return [
    `Resumed session ${sessionId}.`,
    `Directory: ${result.directory}`,
    `Messages: ${result.appliedMessageCount}/${result.messageCount}; parts: ${result.partCount}; interrupted tools: ${result.interruptedToolCount}`,
  ].join("\n");
}

export function formatNewSessionResult(sessionId: string): string {
  return `Started new session ${sessionId}.`;
}
