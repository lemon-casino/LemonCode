// ============================================================
// Event Reducer Helpers - focused projection transforms
// ============================================================

import type { CompactBoundaryPayload } from "../compact/index.js";
import { parseCompactBoundaryPayload } from "../compact/index.js";
import type {
  ActiveToolCall,
  CollaborationMode,
  PendingPermission,
  PendingSteerInputInfo,
  SessionProjection,
  SessionStatus,
} from "../interfaces/session.port.js";
import type {
  BackgroundTaskCompletedPayload,
  BackgroundTaskStartedPayload,
  BackgroundTaskUpdatedPayload,
} from "./session.events.js";
import type {
  StreamRecoveryAnchorPayload,
  StreamingToolLedgerPayload,
} from "./stream-recovery.events.js";

export const initialSessionProjection = {
  createdAt: new Date(),
  updatedAt: new Date(),
  mode: "build" as CollaborationMode,
  status: "idle" as SessionStatus,
  turnCount: 0,
  totalTokenCount: 0,
  contextUsed: 0,
  contextWindow: 200000,
  pendingPermissions: [] as PendingPermission[],
  pendingSteerInputs: [] as PendingSteerInputInfo[],
  activeToolCalls: [] as ActiveToolCall[],
  streamingToolLedger: [] as SessionProjection["streamingToolLedger"],
  backgroundTasks: [] as SessionProjection["backgroundTasks"],
  currentTurnId: undefined as string | undefined,
  lastError: undefined as SessionProjection["lastError"],
  lastCompact: undefined as SessionProjection["lastCompact"],
  lastCheckpoint: undefined as SessionProjection["lastCheckpoint"],
  lastStreamRecoveryAnchor: undefined as SessionProjection["lastStreamRecoveryAnchor"],
  lastRewind: undefined as SessionProjection["lastRewind"],
  target: undefined as SessionProjection["target"],
  targetCompletionVerifications: [] as SessionProjection["targetCompletionVerifications"],
  targetCompletionVerificationTimeline:
    [] as SessionProjection["targetCompletionVerificationTimeline"],
};

export function applyStreamingToolLedgerUpdate(
  projection: SessionProjection,
  payload: StreamingToolLedgerPayload,
  timestamp: Date,
): SessionProjection {
  const next = { ...payload, updatedAt: timestamp };
  const found = projection.streamingToolLedger.some(
    (item) => item.attemptId === payload.attemptId && item.toolCallId === payload.toolCallId,
  );
  return {
    ...projection,
    streamingToolLedger: found
      ? projection.streamingToolLedger.map((item) =>
          item.attemptId === payload.attemptId && item.toolCallId === payload.toolCallId
            ? { ...item, ...next }
            : item,
        )
      : [...projection.streamingToolLedger, next],
    updatedAt: timestamp,
  };
}

export function applyStreamRecoveryAnchorCreated(
  projection: SessionProjection,
  payload: StreamRecoveryAnchorPayload,
  timestamp: Date,
): SessionProjection {
  return {
    ...projection,
    lastStreamRecoveryAnchor: { ...payload, updatedAt: timestamp },
    updatedAt: timestamp,
  };
}

export function applyCompactBoundary(
  projection: SessionProjection,
  payload: unknown,
  timestamp: Date,
): SessionProjection {
  const compactBoundary = parseCompactBoundaryPayload(payload) as CompactBoundaryPayload;
  return {
    ...projection,
    contextUsed:
      compactBoundary.truePostCompactTokenCount ??
      compactBoundary.postCompactTokenCount ??
      projection.contextUsed,
    lastCompact: {
      boundaryId: compactBoundary.boundaryId,
      trigger: compactBoundary.trigger,
      phase: compactBoundary.phase,
      compactReason: compactBoundary.compactReason,
      compactedAt: timestamp,
      preCompactTokenCount: compactBoundary.preCompactTokenCount,
      postCompactTokenCount: compactBoundary.postCompactTokenCount,
      truePostCompactTokenCount: compactBoundary.truePostCompactTokenCount,
      summarizedMessageCount: compactBoundary.summarizedMessageCount,
      keptMessageCount: compactBoundary.keptMessageCount,
      willRetriggerNextTurn: compactBoundary.willRetriggerNextTurn,
    },
    updatedAt: timestamp,
  };
}

export function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const integer = Math.trunc(value);
  return integer > 0 ? integer : undefined;
}

export function applyBackgroundTaskStarted(
  projection: SessionProjection,
  payload: BackgroundTaskStartedPayload,
  timestamp: Date,
): SessionProjection {
  const existing = projection.backgroundTasks.filter((task) => task.taskId !== payload.taskId);
  return {
    ...projection,
    backgroundTasks: [
      ...existing,
      {
        taskId: payload.taskId,
        toolCallId: payload.toolCallId,
        toolName: payload.toolName,
        taskKind: payload.taskKind,
        childSessionId: payload.childSessionId,
        blocked: payload.blocked,
        blockedReason: payload.blockedReason,
        cancellable: payload.cancellable,
        cancelRequestedAt: payload.cancelRequestedAt,
        command: payload.command,
        description: payload.description,
        status: payload.status,
        pid: payload.pid,
        startedAt: payload.startedAt ?? timestamp,
        outputPath: payload.outputPath,
        stderrPersistedOutputPath: payload.stderrPersistedOutputPath,
        stdoutPersistedOutputPath: payload.stdoutPersistedOutputPath,
        outputBytes: payload.outputBytes,
        outputTruncated: payload.outputTruncated,
        outputTail: payload.outputTail,
        stderrBytes: payload.stderrBytes,
        stderrTail: payload.stderrTail,
        stdoutBytes: payload.stdoutBytes,
        stdoutTail: payload.stdoutTail,
        terminalId: payload.terminalId,
      },
    ],
    updatedAt: timestamp,
  };
}

export function applyBackgroundTaskUpdated(
  projection: SessionProjection,
  payload: BackgroundTaskUpdatedPayload,
  timestamp: Date,
): SessionProjection {
  return {
    ...projection,
    backgroundTasks: projection.backgroundTasks.map((task) =>
      task.taskId === payload.taskId ? mergeBackgroundTask(task, payload) : task,
    ),
    updatedAt: timestamp,
  };
}

export function applyBackgroundTaskCompleted(
  projection: SessionProjection,
  payload: BackgroundTaskCompletedPayload,
  timestamp: Date,
): SessionProjection {
  const next = {
    taskId: payload.taskId,
    toolCallId: payload.toolCallId,
    toolName: payload.toolName,
    taskKind: payload.taskKind,
    childSessionId: payload.childSessionId,
    blocked: payload.blocked,
    blockedReason: payload.blockedReason,
    cancellable: payload.cancellable,
    cancelRequestedAt: payload.cancelRequestedAt,
    command: payload.command,
    description: payload.description,
    status: payload.status,
    pid: payload.pid,
    startedAt: payload.startedAt,
    completedAt: payload.completedAt ?? timestamp,
    outputPath: payload.outputPath,
    stderrPersistedOutputPath: payload.stderrPersistedOutputPath,
    stdoutPersistedOutputPath: payload.stdoutPersistedOutputPath,
    outputBytes: payload.outputBytes,
    outputTruncated: payload.outputTruncated,
    outputTail: payload.outputTail,
    stderrBytes: payload.stderrBytes,
    stderrTail: payload.stderrTail,
    stdoutBytes: payload.stdoutBytes,
    stdoutTail: payload.stdoutTail,
    terminalId: payload.terminalId,
  } satisfies SessionProjection["backgroundTasks"][number];

  const found = projection.backgroundTasks.some((task) => task.taskId === payload.taskId);
  return {
    ...projection,
    backgroundTasks: found
      ? projection.backgroundTasks.map((task) =>
          task.taskId === payload.taskId ? mergeBackgroundTask(task, next) : task,
        )
      : [...projection.backgroundTasks, next],
    updatedAt: timestamp,
  };
}

function mergeBackgroundTask(
  current: SessionProjection["backgroundTasks"][number],
  next: Partial<SessionProjection["backgroundTasks"][number]>,
): SessionProjection["backgroundTasks"][number] {
  return {
    ...current,
    ...Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined)),
  } as SessionProjection["backgroundTasks"][number];
}
