import { SessionEventType, type SessionEvent } from "@lcode/contracts";

export interface ColdEventMergeDiagnostic {
  code:
    | "cold_merge.durable_event_suppressed"
    | "cold_merge.ambiguous_legacy_turn_preserved"
    | "cold_merge.settled_queue_event_suppressed"
    | "cold_merge.memory_boundary_preserved"
    | "cold_merge.non_product_event_suppressed"
    | "cold_merge.unclassified_event_preserved";
  count: number;
  eventTypes: Record<string, number>;
}

export const MEMORY_ONLY_EVENT_TYPES = new Set<string>([
  SessionEventType.SessionResumed,
  SessionEventType.SessionTitleUpdated,
  SessionEventType.SessionModeChanged,
  SessionEventType.ExecutionFailoverChanged,
  SessionEventType.PermissionRequested,
  SessionEventType.PermissionResolved,
  SessionEventType.PermissionDenied,
  SessionEventType.UserInputAutoResolutionUpdated,
  SessionEventType.BackgroundTaskStarted,
  SessionEventType.BackgroundTaskUpdated,
  SessionEventType.BackgroundTaskCompleted,
  SessionEventType.BackgroundTaskResultConsumed,
  // workflow run 进度：权威事实在 dwf_event journal 与内存事件里，durable transcript（message/part）
  // 从不合成它，所以它与 BackgroundTask* 同类——memory-only 权威。不分类的后果不是丢事件
  // （兜底分支同样保留），而是每次冷恢复刷一条 unclassified 诊断，把"真的漏了词汇表"这个
  // 信号淹掉。
  SessionEventType.DynamicWorkflowRunProgress,
  SessionEventType.TargetChanged,
  SessionEventType.RewindTriggered,
]);

export const TRANSCRIPT_DERIVED_EVENT_TYPES = new Set<string>([
  SessionEventType.SessionCreated,
  SessionEventType.TurnStarted,
  SessionEventType.ModelSelected,
  SessionEventType.ModelStreaming,
  SessionEventType.ModelComplete,
  SessionEventType.ToolCallScheduled,
  SessionEventType.ToolCallStarted,
  SessionEventType.ToolCallResult,
  SessionEventType.ToolCallError,
  SessionEventType.TurnComplete,
  SessionEventType.TurnError,
  SessionEventType.CompactStarted,
  SessionEventType.CompactCompleted,
  SessionEventType.CompactFailed,
  SessionEventType.TargetCompletionVerification,
  SessionEventType.SessionForked,
  SessionEventType.SubagentSpawned,
  SessionEventType.SubagentMessage,
  SessionEventType.SubagentStopped,
]);

export const HOOK_LIFECYCLE_EVENT_TYPES = new Set<string>([
  SessionEventType.HookRunStarted,
  SessionEventType.HookRunProgress,
  SessionEventType.HookRunCompleted,
  SessionEventType.HookRunFailed,
  SessionEventType.HookRunBlocked,
]);

export function recordDiagnostic(
  diagnostics: Map<ColdEventMergeDiagnostic["code"], ColdEventMergeDiagnostic>,
  code: ColdEventMergeDiagnostic["code"],
  event: SessionEvent,
): void {
  const existing = diagnostics.get(code);
  if (existing) {
    existing.count += 1;
    existing.eventTypes[event.type] = (existing.eventTypes[event.type] ?? 0) + 1;
    return;
  }
  diagnostics.set(code, {
    code,
    count: 1,
    eventTypes: { [event.type]: 1 },
  });
}

export function stringField(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function stringArrayField(payload: unknown, key: string): string[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const value = (payload as Record<string, unknown>)[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

export function resequence(events: readonly SessionEvent[]): SessionEvent[] {
  return events.map((event, index) => ({ ...event, sequenceNumber: index + 1 }));
}
