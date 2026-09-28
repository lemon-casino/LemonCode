import {
  SESSION_ENTRY_WORKSPACE_CHECKPOINT,
  SESSION_ENTRY_WORKSPACE_FILE_REWIND,
  RewindScope,
  SessionEventType,
  createSessionEvent,
  parseCheckpointCreatedPayload,
  parseRewindTriggeredPayload,
  traceContextToLogContext,
} from "../deps.js";
import type {
  SessionEntryInfo,
  SessionEvent,
  TraceContext,
  TraceId,
  TurnId,
} from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";

interface PersistedWorkspaceEvent {
  eventId: string;
  payload: unknown;
  sequenceNumber: number;
  traceId: string;
  turnId?: string;
}

export async function persistWorkspaceCheckpointEntry(
  runtime: AgentRuntimeInternal,
  event: SessionEvent,
  traceContext: TraceContext,
): Promise<void> {
  if (!runtime.sessionStore?.saveSessionEntry) return;

  try {
    const timestamp = event.timestamp.getTime();
    await runtime.sessionStore.saveSessionEntry({
      id: `workspace-checkpoint:${String(event.id)}`,
      sessionID: event.sessionId,
      type: SESSION_ENTRY_WORKSPACE_CHECKPOINT,
      time: { created: timestamp, updated: timestamp },
      // checkpoint artifact 已落盘，但内存 eventStore 会随 child runtime 释放；
      // 只保留 artifact 而不持久化关联 payload，冷恢复后的 preview/apply 无法定位该 artifact。
      data: {
        eventId: String(event.id),
        payload: parseCheckpointCreatedPayload(event.payload),
        sequenceNumber: event.sequenceNumber,
        traceId: String(event.traceId),
        ...(event.turnId ? { turnId: String(event.turnId) } : {}),
      } satisfies PersistedWorkspaceEvent,
    });
  } catch (error) {
    runtime.logger?.warn("Failed to persist workspace checkpoint", {
      ...traceContextToLogContext(traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "checkpoint.persist.failed",
      module: "core.runtime",
      status: "failed",
    });
  }
}

export async function persistWorkspaceFileRewindEntry(
  runtime: AgentRuntimeInternal,
  event: SessionEvent,
  traceContext: TraceContext,
): Promise<void> {
  if (!runtime.sessionStore?.saveSessionEntry) return;

  const payload = parseRewindTriggeredPayload(event.payload);
  if (payload.scope !== RewindScope.Workspace || payload.reason !== "file_summary_rewind") return;

  try {
    const timestamp = event.timestamp.getTime();
    await runtime.sessionStore.saveSessionEntry({
      id: `workspace-file-rewind:${payload.rewindId}`,
      sessionID: event.sessionId,
      type: SESSION_ENTRY_WORKSPACE_FILE_REWIND,
      time: { created: timestamp, updated: timestamp },
      // 文件已撤销是 child turn 的持久状态。只广播内存事件会在关闭详情或
      // 重启后重新显示“撤销”，并让已经恢复的文件再次进入预览。
      data: {
        eventId: String(event.id),
        payload,
        sequenceNumber: event.sequenceNumber,
        traceId: String(event.traceId),
        ...(event.turnId ? { turnId: String(event.turnId) } : {}),
      } satisfies PersistedWorkspaceEvent,
    });
  } catch (error) {
    runtime.logger?.warn("Failed to persist workspace file rewind", {
      ...traceContextToLogContext(traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "workspace_file_rewind.persist.failed",
      module: "core.runtime",
      status: "failed",
    });
  }
}

export async function restoreWorkspaceCheckpointEntries(
  runtime: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<void> {
  if (!runtime.sessionStore?.sessionEntries) return;

  let entries: SessionEntryInfo[];
  try {
    entries = await runtime.sessionStore.sessionEntries({
      sessionID: runtime.sessionId,
      type: SESSION_ENTRY_WORKSPACE_CHECKPOINT,
    });
  } catch (error) {
    runtime.logger?.warn("Failed to read persisted workspace checkpoints", {
      ...traceContextToLogContext(traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "checkpoint.restore.read_failed",
      module: "core.runtime",
      status: "failed",
    });
    return;
  }

  const existingCheckpointIds = new Set(
    (await runtime.eventStore.getEvents(runtime.sessionId)).flatMap((event) => {
      if (event.type !== SessionEventType.CheckpointCreated) return [];
      try {
        return [parseCheckpointCreatedPayload(event.payload).checkpointId];
      } catch {
        return [];
      }
    }),
  );
  const orderedEntries = [...entries].sort((left, right) => {
    const leftSequence = readPersistedWorkspaceCheckpoint(left.data)?.sequenceNumber ?? 0;
    const rightSequence = readPersistedWorkspaceCheckpoint(right.data)?.sequenceNumber ?? 0;
    return leftSequence - rightSequence || left.time.created - right.time.created;
  });

  for (const entry of orderedEntries) {
    const data = readPersistedWorkspaceCheckpoint(entry.data);
    if (!data) continue;
    try {
      const payload = parseCheckpointCreatedPayload(data.payload);
      if (existingCheckpointIds.has(payload.checkpointId)) continue;
      const event = createSessionEvent(
        SessionEventType.CheckpointCreated,
        runtime.sessionId,
        payload,
        {
          traceId: data.traceId as TraceId,
          ...(data.turnId ? { turnId: data.turnId as TurnId } : {}),
        },
      );
      event.timestamp = new Date(entry.time.created);
      event.sequenceNumber = data.sequenceNumber;
      await runtime.eventStore.append(event);
      existingCheckpointIds.add(payload.checkpointId);
    } catch (error) {
      runtime.logger?.warn("Skipped invalid persisted workspace checkpoint", {
        ...traceContextToLogContext(traceContext),
        entryId: entry.id,
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "checkpoint.restore.invalid_entry",
        module: "core.runtime",
        status: "failed",
      });
    }
  }
}

export async function restoreWorkspaceFileRewindEntries(
  runtime: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<void> {
  if (!runtime.sessionStore?.sessionEntries) return;

  let entries: SessionEntryInfo[];
  try {
    entries = await runtime.sessionStore.sessionEntries({
      sessionID: runtime.sessionId,
      type: SESSION_ENTRY_WORKSPACE_FILE_REWIND,
    });
  } catch (error) {
    runtime.logger?.warn("Failed to read persisted workspace file rewinds", {
      ...traceContextToLogContext(traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "workspace_file_rewind.restore.read_failed",
      module: "core.runtime",
      status: "failed",
    });
    return;
  }

  const existingRewindIds = new Set(
    (await runtime.eventStore.getEvents(runtime.sessionId)).flatMap((event) => {
      if (event.type !== SessionEventType.RewindTriggered) return [];
      try {
        return [parseRewindTriggeredPayload(event.payload).rewindId];
      } catch {
        return [];
      }
    }),
  );
  const orderedEntries = [...entries].sort((left, right) => {
    const leftSequence = readPersistedWorkspaceEvent(left.data)?.sequenceNumber ?? 0;
    const rightSequence = readPersistedWorkspaceEvent(right.data)?.sequenceNumber ?? 0;
    return leftSequence - rightSequence || left.time.created - right.time.created;
  });

  for (const entry of orderedEntries) {
    const data = readPersistedWorkspaceEvent(entry.data);
    if (!data) continue;
    try {
      const payload = parseRewindTriggeredPayload(data.payload);
      if (
        payload.scope !== RewindScope.Workspace ||
        payload.reason !== "file_summary_rewind" ||
        existingRewindIds.has(payload.rewindId)
      ) {
        continue;
      }
      const event = createSessionEvent(
        SessionEventType.RewindTriggered,
        runtime.sessionId,
        payload,
        {
          traceId: data.traceId as TraceId,
          ...(data.turnId ? { turnId: data.turnId as TurnId } : {}),
        },
      );
      event.timestamp = new Date(entry.time.created);
      event.sequenceNumber = data.sequenceNumber;
      await runtime.eventStore.append(event);
      existingRewindIds.add(payload.rewindId);
    } catch (error) {
      runtime.logger?.warn("Skipped invalid persisted workspace file rewind", {
        ...traceContextToLogContext(traceContext),
        entryId: entry.id,
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "workspace_file_rewind.restore.invalid_entry",
        module: "core.runtime",
        status: "failed",
      });
    }
  }
}

function readPersistedWorkspaceCheckpoint(value: unknown): PersistedWorkspaceEvent | null {
  return readPersistedWorkspaceEvent(value);
}

function readPersistedWorkspaceEvent(value: unknown): PersistedWorkspaceEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (
    typeof data.eventId !== "string" ||
    typeof data.sequenceNumber !== "number" ||
    typeof data.traceId !== "string" ||
    !("payload" in data) ||
    (data.turnId !== undefined && typeof data.turnId !== "string")
  ) {
    return null;
  }
  return data as unknown as PersistedWorkspaceEvent;
}
