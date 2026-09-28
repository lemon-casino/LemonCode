import {
  SessionEventType,
  STREAM_RECOVERY_DISCARDED_ERROR_NAME,
  STREAM_RECOVERY_DISCARDED_FINISH,
  TurnMachineImpl,
} from "../deps.js";
import type { MessageId, Model, ToolCallId, TraceContext } from "../deps.js";
import { createStreamRecoveryAnchorId, createStreamingToolAttemptId } from "../helpers/index.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { recordModelHistoryRound, type RegularTurnLoopState } from "./turn-loop-state.js";

// 越过 adapter 重试边界后，SSE stall 只能靠 core recovery 从安全锚点重开流；
// 只恢复 1 次会让连续短暂抖动直接失败，和模型默认 10 次 retry 的用户预期差距过大。
const STREAM_RECOVERY_MAX_RETRIES = 10;
const PREVIOUS_MESSAGE_ANCHOR_SUFFIX = "previous-message-anchor";
const START_PLAN_BUSY_PROVIDER_CODES = new Set(["3008", "3009", "3010"]);
const START_PLAN_BUSY_RETRY_PROVIDER_IDS = new Set([
  "account:bigmodel-start-plan",
  "account:zai-start-plan",
]);
const START_PLAN_BUSY_MAIN_TURN_ADMISSION_RETRY_DELAYS_MS = [1_000, 2_000] as const;
export const START_PLAN_BUSY_AUTO_RETRY_EXHAUSTED_MESSAGE =
  "Start Plan is busy and automatic model stream recovery reached the maximum retry count.";
const TRANSIENT_ERROR_CODES = new Set([
  "model_request_timeout",
  "model_rate_limited",
  "model_server_error",
  "model_network_error",
  "MODEL_REQUEST_TIMEOUT",
  "MODEL_RATE_LIMITED",
  "MODEL_SERVER_ERROR",
  "MODEL_NETWORK_ERROR",
]);
const TRANSIENT_ERROR_REASONS = new Set([
  "stream_idle_timeout",
  "rate_limited",
  "server_error",
  "network_error",
  "timeout",
]);

interface StreamRecoveryAttempt {
  maxRetries: number;
  retryNumber: number;
}

export function hasStreamRecoveryBudget(state: RegularTurnLoopState): boolean {
  return state.streamRecoveryRetryCount < STREAM_RECOVERY_MAX_RETRIES;
}

export function isStartPlanBusyStreamRecoveryFailure(error: unknown): boolean {
  for (const record of walkErrorRecords(error)) {
    const context = asRecord(record.context);
    const providerCode =
      stringValue(record.providerCode) ??
      stringValue(context?.providerCode) ??
      stringValue(record.code) ??
      stringValue(context?.code);
    if (providerCode && START_PLAN_BUSY_PROVIDER_CODES.has(providerCode)) {
      return true;
    }
  }
  return false;
}

export function createStartPlanBusyAutoRetryExhaustedError(error: unknown): Error {
  const providerCode = findStartPlanBusyProviderCode(error) ?? "3010";
  const exhaustedError = new Error(START_PLAN_BUSY_AUTO_RETRY_EXHAUSTED_MESSAGE, {
    cause: error instanceof Error ? error : undefined,
  }) as Error & {
    code?: string;
    context?: Record<string, unknown>;
  };
  exhaustedError.name = "StartPlanBusyAutoRetryExhaustedError";
  exhaustedError.code = "model_rate_limited";
  exhaustedError.context = {
    providerCode,
    reason: "rate_limited",
    retryable: false,
    startPlanBusyAutoRetryExhausted: true,
  };
  return exhaustedError;
}

export function beginStreamRecoveryAttempt(state: RegularTurnLoopState): StreamRecoveryAttempt {
  state.streamRecoveryRetryCount += 1;
  return {
    retryNumber: state.streamRecoveryRetryCount,
    maxRetries: STREAM_RECOVERY_MAX_RETRIES,
  };
}

export function beginStartPlanBusyAdmissionRetryAttempt(
  state: RegularTurnLoopState,
): StreamRecoveryAttempt {
  state.streamRecoveryRetryCount += 1;
  return {
    retryNumber: state.streamRecoveryRetryCount,
    maxRetries: START_PLAN_BUSY_MAIN_TURN_ADMISSION_RETRY_DELAYS_MS.length,
  };
}

export function getStartPlanBusyAdmissionRetryDelayMs(input: {
  error: unknown;
  providerId: string;
  state: RegularTurnLoopState;
  turnNumber: number;
}): number | undefined {
  if (input.turnNumber <= 0) return undefined;
  if (!START_PLAN_BUSY_RETRY_PROVIDER_IDS.has(input.providerId)) return undefined;
  if (!isStartPlanBusyStreamRecoveryFailure(input.error)) return undefined;
  return START_PLAN_BUSY_MAIN_TURN_ADMISSION_RETRY_DELAYS_MS[input.state.streamRecoveryRetryCount];
}

export async function emitStreamRecoveryStarted(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  options: { assistantMessageId: MessageId; failedRequestId?: string; traceContext: TraceContext },
  error: unknown,
  recoveryAttempt: StreamRecoveryAttempt,
): Promise<void> {
  const payload = {
    attemptId: createStreamingToolAttemptId(options.assistantMessageId),
    assistantMessageId: options.assistantMessageId,
    failureKind: classifyStreamRecoveryFailure(error),
    message: error instanceof Error ? error.message : String(error),
    retryNumber: recoveryAttempt.retryNumber,
    maxRetries: recoveryAttempt.maxRetries,
    ...(options.failedRequestId ? { failedRequestId: options.failedRequestId } : {}),
  };
  const event = runtime.createEvent(
    SessionEventType.StreamRecoveryStarted,
    payload,
    options.traceContext,
  );
  await runtime.appendEvent(event, options.traceContext);
  state.events.push(event);
}

export async function emitStreamRecoveryRetryEvents(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  options: { assistantMessageId: MessageId; failedRequestId?: string; traceContext: TraceContext },
  recovery: StreamRecoveryAttempt & {
    discardedReasoningBytes: number;
    discardedTextBytes: number;
    reason: "latest_committed_tool_result" | "no_tool_committed";
    toolCallIds: ToolCallId[];
  },
): Promise<void> {
  const latestToolCallId = recovery.toolCallIds.at(-1);
  const anchorId = latestToolCallId
    ? createStreamRecoveryAnchorId(options.assistantMessageId, latestToolCallId)
    : createPreviousMessageRecoveryAnchorId(options.assistantMessageId);
  const recoveryEvents = [
    runtime.createEvent(
      SessionEventType.StreamRecoveryAnchorSelected,
      {
        attemptId: createStreamingToolAttemptId(options.assistantMessageId),
        anchorId,
        reason: recovery.reason,
        committedToolCallIds: recovery.toolCallIds,
      },
      options.traceContext,
    ),
    runtime.createEvent(
      SessionEventType.StreamRecoveryTailDiscarded,
      {
        attemptId: createStreamingToolAttemptId(options.assistantMessageId),
        anchorId,
        assistantMessageId: options.assistantMessageId,
        discardedReasoningBytes: recovery.discardedReasoningBytes,
        discardedTextBytes: recovery.discardedTextBytes,
        discardedToolCallIds: [],
      },
      options.traceContext,
    ),
    runtime.createEvent(
      SessionEventType.StreamRecoveryRetryStarted,
      {
        attemptId: createStreamingToolAttemptId(options.assistantMessageId),
        anchorId,
        retryNumber: recovery.retryNumber,
        maxRetries: recovery.maxRetries,
        streamMode: "sse",
        ...(options.failedRequestId ? { failedRequestId: options.failedRequestId } : {}),
      },
      options.traceContext,
    ),
  ];
  for (const event of recoveryEvents) {
    await runtime.appendEvent(event, options.traceContext);
    state.events.push(event);
  }
  // SSE 已经吐出部分事件后，下一次请求是 core recovery 重新发起的
  // 新模型请求，不会表现为 adapter attempt=2；必须把来源 requestId 显式挂到
  // 下一次 model_request_started 上，用户才能确认旧请求 A 超时后确实发出了恢复请求 B。
  state.pendingStreamRecoveryRequest = {
    attemptId: createStreamingToolAttemptId(options.assistantMessageId),
    anchorId,
    maxRetries: recovery.maxRetries,
    retryNumber: recovery.retryNumber,
    ...(options.failedRequestId ? { recoveredFromRequestId: options.failedRequestId } : {}),
  };
}

export async function recoverPartialAssistantOutputFailure(input: {
  allowProviderFailover?: boolean;
  abortController: AbortController;
  assistantCreatedAt: number;
  discardedReasoningBytes: number;
  discardedTextBytes: number;
  error: unknown;
  options: {
    assistantMessageId: MessageId;
    failedRequestId?: string;
    model: Model;
    traceContext: TraceContext;
  };
  runtime: AgentRuntimeInternal;
  state: RegularTurnLoopState;
  turnAbortListener: () => void;
}): Promise<boolean> {
  if (
    input.discardedReasoningBytes + input.discardedTextBytes <= 0 ||
    (!input.allowProviderFailover && !isRetryableStreamRecoveryFailure(input.error))
  ) {
    return false;
  }

  // reasoning_delta 为了实时展示会越过 adapter 重试边界，但旧 Core 只统计正文，
  // 导致正文前的 thinking 断流直接失败。无工具时正文和思考都属于未提交 assistant tail，
  // 必须统一从前一个 provider-safe anchor 重开，不能把新输出接到失败消息上。
  input.abortController.abort();
  const recoveryAttempt = beginStreamRecoveryAttempt(input.state);
  await emitStreamRecoveryStarted(
    input.runtime,
    input.state,
    input.options,
    input.error,
    recoveryAttempt,
  );
  await input.runtime.persistAssistantMessage(
    input.options.assistantMessageId,
    input.state.currentUserMessageId,
    input.assistantCreatedAt,
    {
      completed: Date.now(),
      error: {
        name: STREAM_RECOVERY_DISCARDED_ERROR_NAME,
        data: {
          message: "Partial assistant output was discarded before a streaming retry.",
          retryNumber: recoveryAttempt.retryNumber,
        },
      },
      finish: STREAM_RECOVERY_DISCARDED_FINISH,
    },
    input.options.traceContext,
    input.options.model,
  );
  input.state.modelResponse = "";
  input.state.modelStepCount += 1;
  recordModelHistoryRound(input.state);
  input.state.turnMachine = new TurnMachineImpl(input.state.turnMachine.receiveModelResponse(""));
  input.state.turnMachine = new TurnMachineImpl(input.state.turnMachine.aggregateResults());
  await emitStreamRecoveryRetryEvents(input.runtime, input.state, input.options, {
    ...recoveryAttempt,
    discardedReasoningBytes: input.discardedReasoningBytes,
    discardedTextBytes: input.discardedTextBytes,
    reason: "no_tool_committed",
    toolCallIds: [],
  });
  input.state.turnAbortSignal.removeEventListener("abort", input.turnAbortListener);
  return true;
}

function createPreviousMessageRecoveryAnchorId(assistantMessageId: MessageId): string {
  return `${assistantMessageId}:${PREVIOUS_MESSAGE_ANCHOR_SUFFIX}`;
}

function findStartPlanBusyProviderCode(error: unknown): string | undefined {
  for (const record of walkErrorRecords(error)) {
    const context = asRecord(record.context);
    const candidates = [
      stringValue(record.providerCode),
      stringValue(context?.providerCode),
      stringValue(record.code),
      stringValue(context?.code),
    ].filter((code): code is string => code !== undefined);
    const providerCode = candidates.find((code) => START_PLAN_BUSY_PROVIDER_CODES.has(code));
    if (providerCode) {
      return providerCode;
    }
  }
  return undefined;
}

export function isRetryableStreamRecoveryFailure(error: unknown): boolean {
  for (const record of walkErrorRecords(error)) {
    if (record.retryable === true) return true;
    const context = asRecord(record.context);
    if (context?.retryable === true) return true;
    const code = stringValue(record.code) ?? stringValue(context?.code);
    if (code && TRANSIENT_ERROR_CODES.has(code)) return true;
    const reason = stringValue(record.reason) ?? stringValue(context?.reason);
    if (reason && TRANSIENT_ERROR_REASONS.has(reason)) return true;
    const name = stringValue(record.name);
    if (name === "ModelStreamIdleTimeoutError") return true;
    const message = stringValue(record.message);
    if (message && isTransientMessage(message)) return true;
  }
  return false;
}

function classifyStreamRecoveryFailure(
  error: unknown,
): "provider_timeout" | "provider_network_error" | "provider_stream_error" | "unknown" {
  for (const record of walkErrorRecords(error)) {
    const context = asRecord(record.context);
    const reason = stringValue(record.reason) ?? stringValue(context?.reason);
    const code = stringValue(record.code) ?? stringValue(context?.code);
    const name = stringValue(record.name);
    const message = stringValue(record.message);
    if (
      reason === "stream_idle_timeout" ||
      code === "model_request_timeout" ||
      code === "MODEL_REQUEST_TIMEOUT" ||
      name === "ModelStreamIdleTimeoutError" ||
      (message !== undefined && /\btimeout|timed out|stalled\b/i.test(message))
    ) {
      return "provider_timeout";
    }
    if (
      reason === "network_error" ||
      code === "model_network_error" ||
      code === "MODEL_NETWORK_ERROR" ||
      (message !== undefined && /\bECONNRESET|EPIPE|ETIMEDOUT\b/i.test(message))
    ) {
      return "provider_network_error";
    }
  }
  return error instanceof Error ? "provider_stream_error" : "unknown";
}

function isTransientMessage(message: string): boolean {
  return /\b(stream idle|stream stalled|timeout|timed out|ECONNRESET|EPIPE|ETIMEDOUT)\b/i.test(
    message,
  );
}

function* walkErrorRecords(error: unknown): Generator<Record<string, unknown>> {
  let current = error;
  const seen = new WeakSet<object>();
  for (let depth = 0; depth <= 6; depth += 1) {
    const record = asRecord(current);
    if (!record) return;
    if (seen.has(record)) return;
    seen.add(record);
    yield record;
    current = record.cause;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object") return undefined;
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
