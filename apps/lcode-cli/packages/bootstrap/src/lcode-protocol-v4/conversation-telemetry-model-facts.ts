import type {
  ModelCompletePayload,
  ModelNetworkStatusPayload,
  ModelStreamingPayload,
  SessionEvent,
} from "@lcode/contracts";
import { getModelUsageTotalTokens, SessionEventType } from "@lcode/contracts";
import {
  conversationTelemetryFactSchema,
  type ConversationTelemetryFact,
} from "@lcode/shared/lcode-protocol-v4";
import {
  optionalString,
  nonNegative,
  recordValue,
  streamingParentToolCallId,
} from "./conversation-telemetry-values.js";
import {
  type ConversationTelemetryState,
  type TelemetryEventContext,
} from "./conversation-telemetry-state.js";

function providerHostname(baseURL: string | undefined): string | undefined {
  if (!baseURL) return undefined;
  try {
    return new URL(baseURL).hostname || undefined;
  } catch {
    return undefined;
  }
}

function totalTokensOf(usage: Record<string, unknown>): number {
  return getModelUsageTotalTokens({
    totalTokens: nonNegative(usage.totalTokens),
    inputTokens: nonNegative(usage.inputTokens),
    outputTokens: nonNegative(usage.outputTokens),
    cacheReadTokens: nonNegative(usage.cacheReadTokens) ?? nonNegative(usage.cacheTokens),
    cacheWriteTokens: nonNegative(usage.cacheWriteTokens),
    reasoningTokens: nonNegative(usage.reasoningTokens),
  });
}

function modelRequestQueueKey(sessionId: string, querySource: string | undefined): string {
  return `${sessionId}\0${querySource ?? ""}`;
}

function isStepUsageQuerySource(querySource: string | undefined): boolean {
  // `workflow_child`：动态工作流子代理。
  // 该来源必须放行，否则子代理的 token 进不了业务埋点。
  return (
    querySource === undefined ||
    querySource === "main_turn" ||
    querySource === "subagent" ||
    querySource === "workflow_child"
  );
}

function isStepUsageModelComplete(payload: ModelCompletePayload): boolean {
  return (
    isStepUsageQuerySource(payload.querySource) &&
    (payload.querySource !== undefined || payload.stopReason !== "tool_internal")
  );
}

// 事实关联表仍由 normalizer 拥有；此函数只借用对应生命周期字段。
export function normalizeModelFact(
  state: Pick<
    ConversationTelemetryState,
    "modelBySession" | "completedModelRequests" | "firstStreamChunks"
  >,
  context: TelemetryEventContext,
  event: SessionEvent,
): ConversationTelemetryFact | null {
  const { sessionId, turnId, sourceCommandId, base } = context;
  switch (event.type) {
    case SessionEventType.ModelNetworkStatus: {
      const payload = event.payload as ModelNetworkStatusPayload;
      // 准入等待的两端不是 provider 请求状态：
      // fact 的 status 枚举不收它们，显式跳过而不是让 schema.parse 抛出。
      if (payload.type === "model_request_queued" || payload.type === "model_request_admitted") {
        return null;
      }
      const modelProvider = String(payload.providerId);
      const modelName = String(payload.modelId);
      state.modelBySession.set(sessionId, { modelName, modelProvider });
      const fact = conversationTelemetryFactSchema.parse({
        ...base,
        kind: "model.request.status",
        ...(sourceCommandId ? { sourceCommandId } : {}),
        requestId: String(payload.requestId),
        status: payload.type,
        providerId: modelProvider,
        modelId: modelName,
        ...(payload.providerKind ? { providerKind: payload.providerKind } : {}),
        ...(providerHostname(payload.baseURL)
          ? { providerHostname: providerHostname(payload.baseURL) }
          : {}),
        transport: payload.transport,
        ...(payload.querySource ? { querySource: payload.querySource } : {}),
        ...(payload.queryId ? { queryId: String(payload.queryId) } : {}),
        attempt: payload.attempt,
        maxAttempts: payload.maxAttempts,
        ...(payload.type === "model_request_completed"
          ? {
              durationMs: payload.durationMs,
            }
          : {}),
        ...(payload.type === "model_request_failed"
          ? {
              ...(payload.durationMs !== undefined ? { durationMs: payload.durationMs } : {}),
              reason: payload.reason,
              retryable: payload.retryable,
              ...(payload.statusCode !== undefined ? { statusCode: payload.statusCode } : {}),
            }
          : {}),
        ...(payload.type === "model_retry_scheduled"
          ? {
              delayMs: payload.delayMs,
              nextAttempt: payload.nextAttempt,
              reason: payload.reason,
              ...(payload.statusCode !== undefined ? { statusCode: payload.statusCode } : {}),
            }
          : {}),
        ...(payload.type === "model_stream_stalled"
          ? { idleMs: payload.idleMs, timeoutMs: payload.timeoutMs }
          : {}),
      });
      const querySource = optionalString(payload.querySource);
      if (payload.type === "model_request_completed" && isStepUsageQuerySource(querySource)) {
        const key = modelRequestQueueKey(sessionId, querySource);
        const queue = state.completedModelRequests.get(key) ?? [];
        queue.push({
          requestId: String(payload.requestId),
          providerId: modelProvider,
          modelId: modelName,
          ...(payload.providerKind ? { providerKind: payload.providerKind } : {}),
          ...(providerHostname(payload.baseURL)
            ? { providerHostname: providerHostname(payload.baseURL) }
            : {}),
        });
        state.completedModelRequests.set(key, queue);
      }
      return fact;
    }
    case SessionEventType.ModelStreaming: {
      const payload = event.payload as ModelStreamingPayload;
      const rawPayload = recordValue(event.payload);
      const channel =
        payload.kind === "text_delta"
          ? "text"
          : payload.kind === "reasoning_delta"
            ? "thought"
            : null;
      if (!channel) return null;
      const parentToolCallId = streamingParentToolCallId(rawPayload);
      const streamKey = `${sessionId}\0${turnId ?? ""}\0${channel}\0${String(payload.partId ?? "")}\0${parentToolCallId ?? ""}`;
      return conversationTelemetryFactSchema.parse({
        ...base,
        kind: "stream.chunk",
        ...(sourceCommandId ? { sourceCommandId } : {}),
        channel,
        chunkLength: payload.delta.length,
        firstChunk: state.firstStreamChunks.add(streamKey),
        ...(payload.assistantMessageId
          ? { assistantMessageId: String(payload.assistantMessageId) }
          : {}),
        ...(payload.partId ? { partId: String(payload.partId) } : {}),
        ...(parentToolCallId ? { parentToolCallId } : {}),
      });
    }
    case SessionEventType.ModelComplete: {
      const payload = event.payload as ModelCompletePayload;
      const requestQueueKey = modelRequestQueueKey(sessionId, optionalString(payload.querySource));
      const completedRequests = state.completedModelRequests.get(requestQueueKey) ?? [];
      const completedRequest = completedRequests.shift();
      if (completedRequests.length > 0) {
        state.completedModelRequests.set(requestQueueKey, completedRequests);
      } else {
        state.completedModelRequests.delete(requestQueueKey);
      }
      // 标题 sidecar 沿用当前 turnId，若把它的 ModelComplete 也转成
      // usage.delta，renderer 会把每轮标题的 64/8 tokens 累加进主对话 completion。
      // 本期只放行主轮和 subagent request usage；sidecar/compact/tool_internal 仍不外送。
      if (!isStepUsageModelComplete(payload)) return null;
      const usage = recordValue(payload.usage);
      return conversationTelemetryFactSchema.parse({
        ...base,
        kind: "usage.delta",
        ...(sourceCommandId ? { sourceCommandId } : {}),
        ...(completedRequest
          ? {
              requestId: completedRequest.requestId,
              providerId: completedRequest.providerId,
              modelId: completedRequest.modelId,
              ...(completedRequest.providerKind
                ? { providerKind: completedRequest.providerKind }
                : {}),
              ...(completedRequest.providerHostname
                ? { providerHostname: completedRequest.providerHostname }
                : {}),
            }
          : {}),
        inputTokens: nonNegative(usage.inputTokens) ?? 0,
        outputTokens: nonNegative(usage.outputTokens) ?? 0,
        totalTokens: totalTokensOf(usage),
        reasoningTokens: nonNegative(usage.reasoningTokens) ?? 0,
        cacheReadTokens: nonNegative(usage.cacheReadTokens) ?? nonNegative(usage.cacheTokens) ?? 0,
        cacheWriteTokens: nonNegative(usage.cacheWriteTokens) ?? 0,
      });
    }
    default:
      return null;
  }
}
