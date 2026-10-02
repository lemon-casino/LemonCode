// 模型请求重试、断流恢复与 active-turn 准入，不改变统计事实来源。
// host 是 ProductProjection 原实例的窄借用视图；函数不持有副本或另建 owner。
import type { ProductProjectionState } from "./product-projection-state.js";
import type {
  SessionEvent,
  ModelNetworkStatusPayload,
  StreamRecoveryStartedPayload,
  StreamRecoveryRetryStartedPayload,
} from "@lcode/contracts";
import type { ConversationDelta, ApiRetryState } from "@lcode/shared/lcode-protocol-v4";
import { positiveInteger } from "./product-projection-model-config.js";
import { ms } from "./product-projection-rows.js";
import { closeStreamingRows } from "./product-projection-model-stream.js";
import { closeOpenToolRows } from "./product-projection-tool-lifecycle.js";
import { controlPatch, isRunning } from "./product-projection-session.js";

type ModelNetworkStatusHost = Pick<ProductProjectionState, "snapshot" | "currentTurnId">;

type StreamRecoveryTailDiscardedHost = Pick<
  ProductProjectionState,
  | "snapshot"
  | "rowIndexById"
  | "streamingTextRowId"
  | "streamingReasoningRowId"
  | "toolRowIdByCallId"
  | "openForegroundToolCallIds"
  | "fileToolInputPreviewByCallId"
  | "currentTurnId"
>;

type SetApiRetryHost = Pick<ProductProjectionState, "snapshot">;

// ── 流式输出 ──

export function onModelNetworkStatus(
  host: ModelNetworkStatusHost,
  event: SessionEvent,
): ConversationDelta[] {
  if (!acceptsActiveModelEvent(host, event)) return [];
  const payload = event.payload as ModelNetworkStatusPayload;
  switch (payload.type) {
    case "model_retry_scheduled": {
      const attempt = positiveInteger(payload.attempt, 1);
      const maxAttempts = Math.max(positiveInteger(payload.maxAttempts, attempt + 1), attempt + 1);
      return setApiRetry(host, {
        attempt,
        maxAttempts,
        nextRetryAt: ms(event) + nonNegativeInteger(payload.delayMs, 0),
        reasonCode: modelRetryReasonCode(payload.reason),
      });
    }
    case "model_request_started":
      if (payload.streamRecovery) {
        return setApiRetry(
          host,
          streamRecoveryApiRetry(
            payload.streamRecovery.retryNumber,
            payload.streamRecovery.maxRetries,
            ms(event),
            host.snapshot.control.apiRetry?.reasonCode ?? "fault.network.sseDisconnected",
          ),
        );
      }
      // adapter attempt=2+ 只说明重试请求已发出，不代表连接恢复；
      // 保持当前状态，等首个有效 text/reasoning/tool 进展再清理，避免标签闪退。
      return positiveInteger(payload.attempt, 1) <= 1 ? setApiRetry(host, null) : [];
    case "model_request_completed":
      return setApiRetry(host, null);
    case "model_request_failed":
      return payload.retryable ? [] : setApiRetry(host, null);
    case "model_stream_stalled":
    case "model_first_provider_event":
    case "model_first_content":
    case "model_first_text":
    // 准入等待的两端是 runtime 观测，不是 UI 状态：
    // 不映射成重试/等待标签。
    case "model_request_queued":
    case "model_request_admitted":
      return [];
  }
}

export function onStreamRecoveryStarted(
  host: ModelNetworkStatusHost,
  event: SessionEvent,
): ConversationDelta[] {
  if (!acceptsActiveModelEvent(host, event)) return [];
  const payload = event.payload as StreamRecoveryStartedPayload;
  return setApiRetry(
    host,
    streamRecoveryApiRetry(
      payload.retryNumber,
      payload.maxRetries,
      ms(event),
      streamRecoveryReasonCode(payload.failureKind),
    ),
  );
}

export function onStreamRecoveryTailDiscarded(
  host: StreamRecoveryTailDiscardedHost,
  event: SessionEvent,
): ConversationDelta[] {
  if (!acceptsActiveModelEvent(host, event)) return [];
  // Bug 原因：Core 已用 tail_discarded 切断失败 assistant attempt，但旧 V4 投影忽略该事件，
  // 下一次 reasoning/text 到达时会把旧行误收口为 complete。这里必须先标 interrupted，
  // 让恢复流用新 assistant identity 打开新行，避免 UI 看起来像一次连续完整输出。
  // Bug 原因：断流时已由 tool_input_start 打开、但还没等到 tool_call 定稿的工具行也属于
  // 被作废的 tail——core 只为已提交的工具合成终态，这些行没人收口；恢复请求会用新的
  // toolCallId 再开一行，UI 于是并排出现两张「正在编写工作流」。已提交（running /
  // pendingApproval）的行不在此列，它们的终态由 executor 自己发布。
  return [
    ...closeStreamingRows(host, "interrupted"),
    ...closeOpenToolRows(host, event, "cancelled", (row) => row.status === "inputStreaming"),
  ];
}

export function onStreamRecoveryRetryStarted(
  host: ModelNetworkStatusHost,
  event: SessionEvent,
): ConversationDelta[] {
  if (!acceptsActiveModelEvent(host, event)) return [];
  const payload = event.payload as StreamRecoveryRetryStartedPayload;
  return setApiRetry(
    host,
    streamRecoveryApiRetry(
      payload.retryNumber,
      payload.maxRetries,
      ms(event),
      host.snapshot.control.apiRetry?.reasonCode ?? "fault.network.sseDisconnected",
    ),
  );
}

function streamRecoveryApiRetry(
  retryNumber: number,
  maxRetriesValue: number,
  nextRetryAt: number,
  reasonCode: string,
): ApiRetryState {
  const attempt = positiveInteger(retryNumber, 1);
  const maxRetries = Math.max(positiveInteger(maxRetriesValue, attempt), attempt);
  return {
    attempt,
    maxAttempts: maxRetries + 1,
    nextRetryAt,
    reasonCode,
  };
}

export function setApiRetry(
  host: SetApiRetryHost,
  apiRetry: ApiRetryState | null,
): ConversationDelta[] {
  const current = host.snapshot.control.apiRetry;
  if (
    current === apiRetry ||
    (current !== null &&
      apiRetry !== null &&
      current.attempt === apiRetry.attempt &&
      current.maxAttempts === apiRetry.maxAttempts &&
      current.nextRetryAt === apiRetry.nextRetryAt &&
      current.reasonCode === apiRetry.reasonCode)
  ) {
    return [];
  }
  return [
    {
      op: "state.updated",
      patch: controlPatch(host, { apiRetry }),
    },
  ];
}

export function acceptsActiveModelEvent(
  host: ModelNetworkStatusHost,
  event: SessionEvent,
): boolean {
  if (!isRunning(host)) return false;
  // stop/新一轮后旧请求可能迟到；仅凭 session 级状态会让旧 turn 的
  // retry/progress 覆盖当前输入栏。当前 runtime turn 已知时必须按 turnId 隔离。
  return (
    host.currentTurnId === null ||
    event.turnId === undefined ||
    String(event.turnId) === host.currentTurnId
  );
}

function modelRetryReasonCode(
  reason: Extract<ModelNetworkStatusPayload, { type: "model_retry_scheduled" }>["reason"],
): string {
  switch (reason) {
    case "rate_limited":
      return "fault.provider.rateLimited";
    // off-peak 排队（429/3105）语义上就是"上游让我们等"，UI 归入限流可恢复形态。
    case "offpeak_queued":
      return "fault.provider.rateLimited";
    case "provider_overloaded":
    case "server_error":
      return "fault.provider.serverError";
    case "timeout":
      return "fault.network.timeout";
    case "stream_idle_timeout":
      return "fault.network.sseStalled";
    case "stale_connection":
      return "fault.network.sseDisconnected";
    case "network_error":
      return "fault.network.unreachable";
    case "auth_refresh":
    case "reasoning_signature_repair":
      return "fault.provider.requestFailed";
  }
}

function streamRecoveryReasonCode(
  failureKind: StreamRecoveryStartedPayload["failureKind"],
): string {
  switch (failureKind) {
    case "provider_timeout":
      return "fault.network.timeout";
    case "provider_network_error":
      return "fault.network.unreachable";
    case "provider_stream_error":
      return "fault.network.sseDisconnected";
    case "provider_turn_failed":
    case "unknown":
      return "fault.provider.requestFailed";
  }
}

function nonNegativeInteger(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}
