import type { QueryId, SessionId, TraceId, TurnId } from "../interfaces/shared.js";
import type { ModelApiErrorPhase, ResolvedModelApiCallObservation } from "../telemetry/index.js";
import type { ModelProviderId, ModelId, ModelErrorCode } from "./protocol-identity.js";
import type { ModelUsage } from "./usage.js";

export const ModelTransportKind = {
  Http: "http",
  Sse: "sse",
  WebSocket: "websocket",
} as const;

export type ModelTransportKind = (typeof ModelTransportKind)[keyof typeof ModelTransportKind];

export const ModelRetryReason = {
  RateLimited: "rate_limited",
  ProviderOverloaded: "provider_overloaded",
  ServerError: "server_error",
  NetworkError: "network_error",
  Timeout: "timeout",
  StreamIdleTimeout: "stream_idle_timeout",
  StaleConnection: "stale_connection",
  AuthRefresh: "auth_refresh",
  /** Anthropic 明确拒绝历史 thinking signature 后，对请求副本清理并立即重试一次。 */
  ReasoningSignatureRepair: "reasoning_signature_repair",
  /** off-peak 闲时排队（429/3105+Retry-After）：豁免重试预算、无限探测（仅 idle plan provider）。 */
  OffpeakQueued: "offpeak_queued",
} as const;

export type ModelRetryReason = (typeof ModelRetryReason)[keyof typeof ModelRetryReason];

export const ModelFailureReason = {
  ...ModelRetryReason,
  AuthFailed: "auth_failed",
  Cancelled: "cancelled",
  ContextExceeded: "context_exceeded",
  InvalidRequest: "invalid_request",
  ProviderNotConfigured: "provider_not_configured",
  ProxyError: "proxy_error",
  TlsError: "tls_error",
  Unknown: "unknown",
} as const;

export type ModelFailureReason = (typeof ModelFailureReason)[keyof typeof ModelFailureReason];

interface ModelNetworkStatusBase {
  timestamp: string;
  traceId: TraceId;
  queryId?: QueryId;
  sessionId?: SessionId;
  turnId?: TurnId;
  parentSessionId?: SessionId;
  toolCallId?: string;
  spanId?: string;
  parentSpanId?: string;
  querySource?: string;
  requestId: string;
  providerId: ModelProviderId;
  modelId: ModelId;
  baseURL?: string;
  providerKind?: string;
  transport: ModelTransportKind;
  attempt: number;
  /**
   * 本次请求的重试预算总尝试数（含首次）。**`0` = 无上限**（`ModelRetryBudget.Unbounded`）：`Infinity` 不可序列化，而 0 不占用任何既有合法值。
   * 消费方渲染「第 n/N 次」或推导 maxRetries 时必须特判 0。
   */
  maxAttempts: number;
  streamRecovery?: ModelStreamRecoveryStatus;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestHeaderCount?: number;
  responseHeaderCount?: number;
  modelCall?: ResolvedModelApiCallObservation;
}

export interface ModelStreamRecoveryStatus {
  attemptId: string;
  retryNumber: number;
  maxRetries: number;
  recoveredFromRequestId?: string;
  anchorId?: string;
}

export interface ModelRequestStartedStatusEvent extends ModelNetworkStatusBase {
  type: "model_request_started";
}

/**
 * 准入等待的两端：runner 的 `tryAcquire` 未命中
 * 即发 `queued`，拿到票即发 `admitted`（带排队时长）。它们是 runtime 观测——driver 据此报「等待槽位」，
 * 工具执行器据此暂停工具超时——不进 provider 请求；协议侧凡枚举状态类型的消费方显式忽略。
 */
export interface ModelRequestQueuedStatusEvent extends ModelNetworkStatusBase {
  type: "model_request_queued";
}

export interface ModelRequestAdmittedStatusEvent extends ModelNetworkStatusBase {
  type: "model_request_admitted";
  queuedMs: number;
}

export interface ModelRequestCompletedStatusEvent extends ModelNetworkStatusBase {
  type: "model_request_completed";
  durationMs: number;
  finishReason?: string;
  usage?: ModelUsage;
  providerRequestId?: string;
  timeToFirstProviderEventMs?: number;
  timeToFirstContentMs?: number;
  timeToFirstTextMs?: number;
  streamMaxIdleMs?: number;
  streamStallCount?: number;
  streamOutputCommitted?: boolean;
}

export interface ModelRequestFailedStatusEvent extends ModelNetworkStatusBase {
  type: "model_request_failed";
  durationMs?: number;
  reason: ModelFailureReason;
  retryable: boolean;
  message: string;
  statusCode?: number;
  errorCode?: ModelErrorCode;
  providerErrorCode?: string;
  providerErrorMessage?: string;
  providerRequestId?: string;
  retryAfterMs?: number;
  errorPhase?: ModelApiErrorPhase;
  exceptionType?: string;
  streamOutputCommitted?: boolean;
}

export interface ModelRetryScheduledStatusEvent extends ModelNetworkStatusBase {
  type: "model_retry_scheduled";
  delayMs: number;
  nextAttempt: number;
  reason: ModelRetryReason;
  message: string;
  statusCode?: number;
  errorCode?: ModelErrorCode;
  providerErrorCode?: string;
  providerErrorMessage?: string;
  providerRequestId?: string;
  retryAfterMs?: number;
}

export interface ModelStreamStalledStatusEvent extends ModelNetworkStatusBase {
  type: "model_stream_stalled";
  idleMs: number;
  timeoutMs: number;
  message: string;
}

/**
 * 仅供实时观测 Sink 消费的 Provider 里程碑。它们不进入 SessionEvent/回放协议，
 * 避免为了 Trace 事件扩大产品状态面。
 */
export interface ModelTelemetryMilestoneStatusEvent extends ModelNetworkStatusBase {
  type: "model_first_provider_event" | "model_first_content" | "model_first_text";
  elapsedMs: number;
}

export type ModelNetworkStatusEvent =
  | ModelRequestQueuedStatusEvent
  | ModelRequestAdmittedStatusEvent
  | ModelRequestStartedStatusEvent
  | ModelRequestCompletedStatusEvent
  | ModelRequestFailedStatusEvent
  | ModelRetryScheduledStatusEvent
  | ModelStreamStalledStatusEvent
  | ModelTelemetryMilestoneStatusEvent;

export interface ModelStatusSink {
  publish(event: ModelNetworkStatusEvent): void | Promise<void>;
  /**
   * Transport 捕获失败时可把原始异常直接交给进程级观测 Sink。产品 SessionEvent/日志仍只消费
   * publish(event)，避免原始异常对象和消息正文进入持久化领域状态。
   */
  publishFailure?(event: ModelRequestFailedStatusEvent, error: unknown): void | Promise<void>;
}
