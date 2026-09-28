import { SessionEventType, type SessionEvent } from "@lcode/contracts";

const TOOL_EVENTS = new Set<string>([
  SessionEventType.ToolCallScheduled,
  SessionEventType.ToolCallStarted,
  SessionEventType.ToolCallProgress,
  SessionEventType.ToolCallResult,
  SessionEventType.ToolCallError,
]);

export function isSubagentToolMirror(event: SessionEvent): boolean {
  return (
    TOOL_EVENTS.has(event.type) &&
    (event.payload as Record<string, unknown> | null)?.source === "subagent"
  );
}

/** Directory refreshes follow lifecycle boundaries, never individual tokens. */
export function changesSubagentDirectory(event: SessionEvent): boolean {
  return !isSubagentToolMirror(event) && DIRECTORY_EVENTS.has(event.type);
}

const DIRECTORY_EVENTS = new Set<string>([
  SessionEventType.SubagentSpawned,
  SessionEventType.SubagentStopped,
  SessionEventType.BackgroundTaskStarted,
  SessionEventType.BackgroundTaskUpdated,
  SessionEventType.BackgroundTaskCompleted,
  SessionEventType.ToolCallResult,
  SessionEventType.TurnStarted,
  SessionEventType.TurnComplete,
  SessionEventType.TurnError,
  SessionEventType.PermissionRequested,
  SessionEventType.PermissionResolved,
  SessionEventType.PermissionDenied,
  SessionEventType.SessionResumed,
]);
