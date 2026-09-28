import {
  SessionEventType,
  type ModelUsageSummary,
  type SessionEvent,
  type TodoItem,
  type TurnId,
} from "@lcode/contracts";
import type { TuiCopy } from "@lcode/i18n";
import type React from "react";
import type {
  CacheStats,
  ContextUsage,
  Message,
  ModifiedFileStat,
  NetworkRequest,
  QueuedInput,
} from "./app-model.js";
import { contextWindowFromPayload, formatEventError, usageFromPayload } from "./app-event-data.js";
import { applyModelStreamingEvent } from "./app-model-streaming.js";
import {
  applyModifiedFileStats,
  modifiedFileStatsFromToolResultPayload,
} from "./app-modified-files.js";
import { applyModelNetworkEvent, applyNetworkRequestEvent } from "./app-network-events.js";
import { appendSystemErrorMessage } from "./app-transcript-errors.js";
import { applyTurnCompleteEvent, applyTurnCompleteFallbackResponse } from "./app-turn-complete.js";
import { applyToolTranscriptEvent } from "./app-tool-transcript.js";
import { DEFAULT_TUI_COPY } from "./app-locale.js";
import { removeQueuedInputs, upsertQueuedInput } from "./app-queued-inputs.js";
import { applyCompactTimelineEvent, applyCompactTurnErrorEvent } from "./app-compact-timeline.js";
import { applyWorkflowProgressEvent, type WorkflowMirrorSetter } from "./app-workflow-events.js";
import { asRecord, formatNumber, numberField, stringField } from "./state.js";

type SessionEventHandlers = {
  setActiveTurnId: (turnId: TurnId | undefined) => void;
  setCacheStats: React.Dispatch<React.SetStateAction<CacheStats | undefined>>;
  setContextUsage: React.Dispatch<React.SetStateAction<ContextUsage>>;
  setLastError: (message: string | undefined) => void;
  setLiveModelText: React.Dispatch<React.SetStateAction<string>>;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  setModel: (model: string) => void;
  setThoughtLevel?: (level: string) => void;
  setModifiedFiles?: React.Dispatch<React.SetStateAction<ModifiedFileStat[]>>;
  setNetworkRequests: React.Dispatch<React.SetStateAction<NetworkRequest[]>>;
  setQueuedInputs?: React.Dispatch<React.SetStateAction<QueuedInput[]>>;
  setStatus: (status: string) => void;
  setTodos: React.Dispatch<React.SetStateAction<TodoItem[]>>;
  setUsage: React.Dispatch<React.SetStateAction<ModelUsageSummary | undefined>>;
  setWorkflowMirror?: WorkflowMirrorSetter;
  assistantMessageIdsByToolCallId: Map<string, string>;
  modifiedFileToolCallIds?: Set<string>;
  toolNamesById: Map<string, string>;
  workspaceDirectory?: string;
};

export function applySessionEventToState(
  event: SessionEvent,
  handlers: SessionEventHandlers,
  copy: TuiCopy = DEFAULT_TUI_COPY,
): void {
  const payload = asRecord(event.payload);

  switch (event.type) {
    case SessionEventType.SessionCreated:
      applySessionCreatedEvent(payload, handlers.setContextUsage);
      break;
    case SessionEventType.TurnStarted:
      handlers.setActiveTurnId(event.turnId);
      handlers.setStatus(copy.status.thinking);
      break;
    case SessionEventType.TurnComplete:
      applyTurnCompleteEvent(payload, handlers.setUsage, handlers.setCacheStats);
      applyTurnCompleteFallbackResponse(payload, handlers.setMessages);
      handlers.setStatus(copy.status.ready);
      handlers.setActiveTurnId(undefined);
      handlers.setQueuedInputs?.([]);
      break;
    case SessionEventType.TurnError:
    case SessionEventType.ModelError:
      if (stringField(payload, "turnPhase") === "compact") {
        applyCompactTurnErrorEvent(payload, handlers.setLastError, handlers.setMessages);
        handlers.setStatus(copy.status.compactFailed);
        handlers.setQueuedInputs?.([]);
        break;
      }
      applyTurnErrorEvent(payload, handlers.setLastError, handlers.setMessages);
      handlers.setStatus(copy.status.turnFailed);
      handlers.setQueuedInputs?.([]);
      break;
    case SessionEventType.TurnSteerQueued:
      applyTurnSteerQueuedEvent(payload, handlers.setQueuedInputs);
      break;
    case SessionEventType.TurnSteerDrained:
    case SessionEventType.TurnSteerDiscarded:
      applyTurnSteerFinishedEvent(payload, handlers.setQueuedInputs);
      break;
    case SessionEventType.AssistantMessage:
      applyAssistantMessageEvent(payload, handlers.setMessages);
      break;
    case SessionEventType.ModelRequest:
      handlers.setStatus(copy.status.modelCalling);
      break;
    case SessionEventType.ModelSelected:
      applyModelSelectedEvent(payload, handlers.setModel, handlers.setThoughtLevel);
      break;
    case SessionEventType.ModelStreaming:
      applyModelStreamingEvent(payload, {
        assistantMessageIdsByToolCallId: handlers.assistantMessageIdsByToolCallId,
        setLiveModelText: handlers.setLiveModelText,
        setMessages: handlers.setMessages,
        setStatus: handlers.setStatus,
      });
      break;
    case SessionEventType.StreamRecoveryStarted:
      handlers.setStatus(copy.status.recoveringStream);
      break;
    case SessionEventType.StreamRecoveryTailDiscarded:
      applyStreamRecoveryTailDiscardedEvent(handlers.setStatus, handlers.setLiveModelText, copy);
      break;
    case SessionEventType.StreamRecoveryRetryStarted:
      handlers.setStatus(copy.status.retryingStream);
      break;
    case SessionEventType.ModelComplete:
      applyModelCompleteEvent(
        payload,
        handlers.setUsage,
        handlers.setStatus,
        handlers.setContextUsage,
        copy,
      );
      break;
    case SessionEventType.ToolCallScheduled:
      rememberToolName(payload, handlers.toolNamesById);
      applyToolTranscriptEvent(event, handlers);
      handlers.setStatus(copy.status.toolPending(toolLabel(payload, handlers.toolNamesById)));
      break;
    case SessionEventType.ToolCallStarted:
    case SessionEventType.ToolCallProgress:
      rememberToolName(payload, handlers.toolNamesById);
      applyToolTranscriptEvent(event, handlers);
      handlers.setStatus(copy.status.toolRunning(toolLabel(payload, handlers.toolNamesById)));
      break;
    case SessionEventType.ToolCallResult:
      applyToolTranscriptEvent(event, handlers);
      applyModifiedFileDisplayEvent(payload, handlers);
      applyToolResultEvent(
        payload,
        handlers.toolNamesById,
        handlers.setTodos,
        handlers.setStatus,
        copy,
      );
      break;
    case SessionEventType.ToolCallError:
      applyToolTranscriptEvent(event, handlers);
      handlers.setStatus(copy.status.toolFailed(toolLabel(payload, handlers.toolNamesById)));
      handlers.setLastError(formatEventError(payload));
      break;
    case SessionEventType.NetworkRequestStatus:
      applyNetworkRequestEvent(payload, handlers.setNetworkRequests);
      break;
    case SessionEventType.ModelNetworkStatus:
      applyModelNetworkEvent(payload, handlers.setNetworkRequests, handlers.setStatus, copy);
      break;
    case SessionEventType.PermissionRequested:
      handlers.setStatus(
        copy.status.permissionRequested(stringField(payload, "toolName") ?? "tool"),
      );
      break;
    case SessionEventType.PermissionResolved:
      handlers.setStatus(
        copy.status.permissionResolved(stringField(payload, "toolName") ?? "tool"),
      );
      break;
    case SessionEventType.SessionResumed:
      handlers.setStatus(copy.status.sessionResumed);
      handlers.setQueuedInputs?.([]);
      break;
    case SessionEventType.SessionCompacted:
      handlers.setStatus(copy.status.compacted);
      break;
    case SessionEventType.CompactStarted:
      applyCompactTimelineEvent(payload, handlers.setMessages);
      handlers.setStatus(
        stringField(payload, "status") === "retrying"
          ? copy.transcript.compact.retrying({
              attempt: numberField(payload, "attempt") ?? 0,
              maxAttempts: numberField(payload, "maxAttempts") ?? 0,
            })
          : copy.status.compacting,
      );
      break;
    case SessionEventType.CompactCompleted:
      applyCompactTimelineEvent(payload, handlers.setMessages);
      handlers.setStatus(
        stringField(payload, "status") === "skipped"
          ? copy.transcript.compact.skipped
          : copy.status.compacted,
      );
      break;
    case SessionEventType.CompactFailed:
      applyCompactTimelineEvent(payload, handlers.setMessages);
      handlers.setStatus(copy.status.compactFailed);
      handlers.setLastError(stringField(payload, "reason"));
      break;
    case SessionEventType.TargetChanged:
      handlers.setStatus(copy.status.targetChanged(stringField(payload, "action") ?? "changed"));
      break;
    // dwf 实时运行态：缺此 case 时事件落进 default 被静默丢弃。归约走共享 reducer。
    case SessionEventType.DynamicWorkflowRunProgress:
      applyWorkflowProgressEvent(event.payload, handlers.setWorkflowMirror);
      break;
    default:
      break;
  }
}

function applyTurnSteerQueuedEvent(
  payload: Record<string, unknown>,
  setQueuedInputs?: React.Dispatch<React.SetStateAction<QueuedInput[]>>,
): void {
  if (!setQueuedInputs) return;

  const id = stringField(payload, "pendingInputId");
  const text = stringField(payload, "inputPreview") ?? stringField(payload, "input");
  if (!id || !text) return;

  setQueuedInputs((current) =>
    upsertQueuedInput(current, { id, text }, { preserveExistingText: true }),
  );
}

function applyTurnSteerFinishedEvent(
  payload: Record<string, unknown>,
  setQueuedInputs?: React.Dispatch<React.SetStateAction<QueuedInput[]>>,
): void {
  if (!setQueuedInputs) return;
  setQueuedInputs((current) =>
    removeQueuedInputs(current, stringArrayField(payload, "pendingInputIds")),
  );
}

function stringArrayField(payload: Record<string, unknown>, key: string): string[] {
  const value = payload[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function applyAssistantMessageEvent(
  payload: Record<string, unknown>,
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>,
): void {
  const content = stringField(payload, "content");
  if (!content) return;
  setMessages((current) => [
    ...current,
    {
      content,
      role: "agent",
    },
  ]);
}

function applyTurnErrorEvent(
  payload: Record<string, unknown>,
  setLastError: (message: string | undefined) => void,
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>,
): void {
  const message = formatEventError(payload);
  setLastError(message);
  setMessages((current) => appendSystemErrorMessage(current, message));
}

function applySessionCreatedEvent(
  payload: Record<string, unknown>,
  setContextUsage: React.Dispatch<React.SetStateAction<ContextUsage>>,
): void {
  const contextWindow = contextWindowFromPayload(payload);
  if (contextWindow === undefined) return;
  setContextUsage((current) => ({
    ...current,
    contextWindow,
  }));
}

function applyModelSelectedEvent(
  payload: Record<string, unknown>,
  setModel: (model: string) => void,
  setThoughtLevel?: (level: string) => void,
): void {
  const modelSelection = asRecord(payload.modelSelection);
  const providerId = stringField(modelSelection, "providerId");
  const modelId =
    stringField(modelSelection, "modelId") ??
    stringField(modelSelection, "id") ??
    stringField(modelSelection, "model");
  if (!modelId) return;
  setModel(providerId ? `${providerId}/${modelId}` : modelId);
  setThoughtLevel?.(stringField(asRecord(modelSelection.options), "reasoningLevel") ?? "");
}

function applyModelCompleteEvent(
  payload: Record<string, unknown>,
  setUsage: React.Dispatch<React.SetStateAction<ModelUsageSummary | undefined>>,
  setStatus: (status: string) => void,
  setContextUsage: React.Dispatch<React.SetStateAction<ContextUsage>>,
  copy: TuiCopy,
): void {
  const nextUsage = usageFromPayload(payload);
  if (nextUsage) {
    setUsage(nextUsage);
    if (nextUsage.inputTokens > 0) {
      setContextUsage((current) => ({
        ...current,
        contextUsed: nextUsage.inputTokens,
      }));
    }
  }
  setStatus(
    nextUsage
      ? copy.model.responseReceivedWithTokens(formatNumber(nextUsage.totalTokens))
      : copy.model.responseReceived,
  );
}

function applyStreamRecoveryTailDiscardedEvent(
  setStatus: (status: string) => void,
  setLiveModelText: React.Dispatch<React.SetStateAction<string>>,
  copy: TuiCopy,
): void {
  setLiveModelText("");
  setStatus(copy.status.interruptedStreamDiscarded);
}

function rememberToolName(
  payload: Record<string, unknown>,
  toolNamesById: Map<string, string>,
): void {
  const toolCallId = stringField(payload, "toolCallId");
  const toolName = stringField(payload, "toolName");
  if (toolCallId && toolName) {
    toolNamesById.set(toolCallId, toolName);
  }
}

function toolLabel(payload: Record<string, unknown>, toolNamesById: Map<string, string>): string {
  const toolCallId = stringField(payload, "toolCallId");
  return (
    stringField(payload, "toolName") ??
    (toolCallId ? toolNamesById.get(toolCallId) : undefined) ??
    "tool"
  );
}

function applyToolResultEvent(
  payload: Record<string, unknown>,
  toolNamesById: Map<string, string>,
  setTodos: React.Dispatch<React.SetStateAction<TodoItem[]>>,
  setStatus: (status: string) => void,
  copy: TuiCopy,
): void {
  const toolName = toolLabel(payload, toolNamesById);
  setStatus(copy.status.toolCompleted(toolName));
  if (toolName !== "TodoWrite") return;

  const result = asRecord(payload.result);
  const content = stringField(result, "content");
  if (!content) return;
  try {
    const parsed = JSON.parse(content) as { todos?: unknown[] };
    if (!Array.isArray(parsed.todos)) return;
    const todos = parsed.todos
      .map((item) => parseTodoItem(item))
      .filter((item): item is TodoItem => Boolean(item));
    if (todos.length === parsed.todos.length) setTodos(todos);
  } catch {
    // Non-JSON tool content is normal for most tools.
  }
}

function applyModifiedFileDisplayEvent(
  payload: Record<string, unknown>,
  handlers: SessionEventHandlers,
): void {
  if (!handlers.setModifiedFiles) return;

  const toolCallId = stringField(payload, "toolCallId");
  if (!toolCallId) return;
  if (handlers.modifiedFileToolCallIds?.has(toolCallId)) return;

  const stats = modifiedFileStatsFromToolResultPayload(payload, handlers.workspaceDirectory);
  if (stats.length === 0) return;

  handlers.modifiedFileToolCallIds?.add(toolCallId);
  handlers.setModifiedFiles((current) => applyModifiedFileStats(current, stats));
}

function parseTodoItem(value: unknown): TodoItem | undefined {
  const item = asRecord(value);
  const content = stringField(item, "content");
  const status = item.status;
  const priority = item.priority;
  if (
    !content ||
    (status !== "pending" && status !== "in_progress" && status !== "completed") ||
    (priority !== "high" && priority !== "medium" && priority !== "low")
  ) {
    return undefined;
  }
  return {
    content,
    priority,
    status,
  };
}
