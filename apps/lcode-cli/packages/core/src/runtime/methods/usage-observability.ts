import {
  SessionEventType,
  createModelUsageSummaryFromEvents,
  traceContextToLogContext,
} from "../deps.js";
import type { MessageId, Model, SessionEvent, TraceContext, TurnId } from "@lcode/contracts";
import type { RuntimeModelTextResult } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { isModelContextExceededError } from "../helpers/index.js";
import {
  usageStoreFor,
  modelNetworkEvents,
  firstModelTokenAt,
  errorInfoFor,
} from "./usage-observability-common.js";
export { recordToolUsageFromEvent } from "./usage-tool-observability.js";

type ModelUsageQuerySource =
  | "main_turn"
  | "compact"
  | "session_title"
  | "goal_completion_verification"
  | string;

interface RecordModelUsageInput {
  assistantMessageId?: MessageId;
  attemptIndex?: number;
  error?: unknown;
  events: readonly SessionEvent[];
  model: Model;
  networkEventStartIndex: number;
  parentUserMessageId?: MessageId;
  querySource: ModelUsageQuerySource;
  result?: RuntimeModelTextResult;
  startedAt: number;
  status: "completed" | "error" | "cancelled";
  toolCallCount?: number;
  traceContext: TraceContext;
}

interface RecordTurnUsageInput {
  completedAt: number;
  error?: unknown;
  events: readonly SessionEvent[];
  startedAt: number;
  status: "completed" | "error" | "cancelled";
  traceContext: TraceContext;
  turnId: TurnId;
  userMessageId?: MessageId;
}

export async function recordModelUsageFact(
  runtime: AgentRuntimeInternal,
  input: RecordModelUsageInput,
): Promise<void> {
  const usageStore = usageStoreFor(runtime);
  if (!usageStore) return;

  const completedAt = Date.now();
  const usage = input.result?.usage;
  const networkEvents = modelNetworkEvents(input.events.slice(input.networkEventStartIndex));
  const retryCount = networkEvents.filter((event) => event.type === "model_retry_scheduled").length;
  const failedNetworkEvent = networkEvents.findLast(
    (event) => event.type === "model_request_failed",
  );
  const firstTokenAt = firstModelTokenAt(input.events, input.networkEventStartIndex);
  const durationMs = completedAt - input.startedAt;
  const errorInfo = errorInfoFor(input.error, failedNetworkEvent);
  const contextExceeded =
    isModelContextExceededError(input.error) || failedNetworkEvent?.reason === "context_exceeded";

  try {
    await usageStore.recordModelUsage({
      id: modelUsageId(input),
      logicalRequestId:
        input.assistantMessageId ??
        input.traceContext.spanId ??
        `${input.querySource}:${input.startedAt}`,
      attemptIndex: input.attemptIndex,
      sessionID: runtime.sessionId,
      turnID: input.traceContext.turnId,
      traceID: input.traceContext.traceId,
      spanID: input.traceContext.spanId,
      assistantMessageID: input.assistantMessageId,
      parentUserMessageID: input.parentUserMessageId,
      querySource: input.querySource,
      providerId: input.model.providerId,
      modelId: input.model.modelId,
      reasoningLevel: input.model.options.reasoningLevel,
      agent: runtime.config.agentName ?? "lcode-agent",
      mode: runtime.config.mode ?? "build",
      taskType: runtime.config.taskType ?? "interactive",
      status: input.status,
      startedAt: input.startedAt,
      firstTokenAt,
      completedAt,
      durationMs,
      timeToFirstTokenMs: firstTokenAt === undefined ? undefined : firstTokenAt - input.startedAt,
      finishReason: input.result?.finishReason,
      toolCallCount: input.toolCallCount ?? 0,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      reasoningTokens: usage?.reasoningTokens,
      cacheCreationInputTokens: usage?.cacheWriteTokens,
      cacheReadInputTokens: usage?.cacheReadTokens,
      providerTotalTokens: usage?.totalTokens,
      retryCount,
      retryable: errorInfo.retryable ?? retryCount > 0,
      cancelledByUser: input.status === "cancelled",
      contextExceeded,
      errorType: errorInfo.type,
      errorCode: errorInfo.code,
      errorMessage: errorInfo.message,
      rawUsage: usage,
      providerMetadata: input.result?.providerMetadata,
    });
  } catch (error) {
    runtime.logger?.warn("Usage model fact write failed", {
      ...traceContextToLogContext(input.traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "usage.model.write.failed",
      module: "core.runtime",
      status: "failed",
    });
  }
}

export async function recordTurnUsageFact(
  runtime: AgentRuntimeInternal,
  input: RecordTurnUsageInput,
): Promise<void> {
  const usageStore = usageStoreFor(runtime);
  if (!usageStore) return;

  const usage = createModelUsageSummaryFromEvents(input.events);
  const modelRequests = input.events.filter(
    (event) => event.type === SessionEventType.ModelRequest,
  );
  const firstModelStartAt = modelRequests[0]?.timestamp.getTime();
  const firstTokenAt = firstModelTokenAt(input.events, 0);
  const toolScheduledIds = new Set<string>();
  const toolErrorIds = new Set<string>();
  for (const event of input.events) {
    if (event.type === SessionEventType.ToolCallScheduled) {
      const payload = event.payload as { toolCallId?: string };
      if (payload.toolCallId) toolScheduledIds.add(payload.toolCallId);
    }
    if (event.type === SessionEventType.ToolCallError) {
      const payload = event.payload as { toolCallId?: string };
      if (payload.toolCallId) toolErrorIds.add(payload.toolCallId);
    }
  }

  const errorInfo = errorInfoFor(input.error, undefined);
  const contextExceeded = isModelContextExceededError(input.error);

  try {
    await usageStore.upsertTurnUsage({
      sessionID: runtime.sessionId,
      turnID: input.turnId,
      traceID: input.traceContext.traceId,
      userMessageID: input.userMessageId,
      status: input.status,
      startedAt: input.startedAt,
      firstModelStartAt,
      firstTokenAt,
      completedAt: input.completedAt,
      durationMs: input.completedAt - input.startedAt,
      timeToFirstTokenMs: firstTokenAt === undefined ? undefined : firstTokenAt - input.startedAt,
      modelRequestCount: modelRequests.length,
      modelRetryCount: modelNetworkEvents(input.events).filter(
        (event) => event.type === "model_retry_scheduled",
      ).length,
      toolCallCount: toolScheduledIds.size,
      toolErrorCount: toolErrorIds.size,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      reasoningTokens: usage?.reasoningTokens,
      cacheCreationInputTokens: usage?.cacheWriteTokens,
      cacheReadInputTokens: usage?.cacheReadTokens,
      computedTotalTokens: usage?.totalTokens,
      retryable: errorInfo.retryable,
      cancelledByUser: input.status === "cancelled",
      contextExceeded,
      errorType: errorInfo.type,
      errorCode: errorInfo.code,
    });
  } catch (error) {
    runtime.logger?.warn("Usage turn fact write failed", {
      ...traceContextToLogContext(input.traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "usage.turn.write.failed",
      module: "core.runtime",
      status: "failed",
    });
  }
}

function modelUsageId(input: RecordModelUsageInput): string {
  const logicalId =
    input.assistantMessageId ??
    input.traceContext.spanId ??
    `${input.querySource}_${input.startedAt}`;
  return `usage_model_${input.querySource}_${logicalId}_${input.attemptIndex ?? 0}`;
}
