import {
  ModelErrorCode,
  ModelFailureReason as ModelFailureReasonValue,
  ModelProtocolError,
  ModelRetryReason,
  type ModelRetryBudget,
} from "@lcode/contracts";
import { classifyModelFailure, type ClassifiedModelFailure } from "./failure-classifier.js";
import { getResponseHeaders, unwrapRetryError } from "./failure-inspection.js";
import { offPeakTicketExpiredMessage, resolveOffPeakFailureDecision } from "./offpeak-retry.js";
import { type AttemptAdmission } from "./request-admission.js";
import { retryBudgetMaxAttempts } from "./retry-budget.js";
import { recordStreamTextDebug } from "./runner-debug.js";
import { logStreamFailureDiagnostics } from "./runner-diagnostics.js";
import {
  createDeferredRetryYieldGate,
  RetryYieldBeforeInvocationError,
} from "./runner-failover-yield.js";
import { sanitizeModelNetworkHeaders } from "./runner-network-headers.js";
import {
  calculateRetryDelay,
  logRetryDelayDecision,
  sleep,
  TerminalStreamChunkError,
  toAdapterError,
} from "./runner-retry.js";
import { RuntimeHeadersRefreshError } from "./runner-runtime-headers.js";
import { publishModelStatus } from "./runner-status.js";
import { modelFailureStatusFields, readModelFailureErrorPhase } from "./runner-telemetry.js";

import { publishRetryScheduledStatus, statusPublishOptions } from "./runner-attempt-status.js";
import type { ModelRunnerRetryState } from "./runner-request-state.js";
import { resolveStreamFailureDecision } from "./runner-stream-failure-policy.js";
import type {
  StreamAttemptState,
  StreamDebugOptions,
  StreamRunnerInput,
} from "./runner-stream-state.js";

type AttemptState = Pick<
  StreamAttemptState,
  | "attempt"
  | "retryBudgetAttempt"
  | "startedAt"
  | "emittedEvent"
  | "emittedRetryBoundaryEvent"
  | "emittedError"
  | "diagnostics"
  | "attemptRequest"
  | "statusContext"
  | "toolCallAssembler"
  | "streamIterator"
  | "attemptFailed"
  | "awaitIteratorClose"
  | "terminalStatusPublished"
  | "options"
  | "result"
  | "requestHeaders"
  | "requestHeaderCount"
  | "resolved"
  | "streamOutputCommitted"
>;
type RetryState = Pick<ModelRunnerRetryState, "pendingRetryYield">;

export async function handleStreamFailure(
  input: StreamRunnerInput,
  retryState: RetryState,
  state: AttemptState,
  admission: AttemptAdmission,
  error: unknown,
  debug: StreamDebugOptions,
  repairThinkingSignatureRejection: (error: unknown) => boolean,
  closeAttemptBeforeRetryYield: () => Promise<void>,
  retryBudget: ModelRetryBudget | undefined,
): Promise<boolean> {
  state.attemptFailed = true;
  if (error instanceof RetryYieldBeforeInvocationError) {
    throw error.adapterError;
  }
  if (debug.recordModelIO && state.options) {
    await recordStreamTextDebug({
      modelIoFullRetentionEnabled: input.modelIoFullRetentionEnabled,
      attempt: state.attempt,
      debugDir: input.debugDir,
      error,
      isDev: debug.isDev,
      normalizedToolCalls: state.toolCallAssembler.snapshotNormalizedToolCalls(),
      options: state.options,
      recordModelIO: debug.recordModelIO,
      request: state.attemptRequest,
      requestId: state.statusContext.requestId,
      resolved: state.resolved,
      result: state.result,
      startedAt: state.startedAt,
    });
  }
  if (error instanceof TerminalStreamChunkError) {
    state.awaitIteratorClose = true;
    throw error.adapterError;
  }
  if (
    error instanceof ModelProtocolError &&
    error.code === ModelErrorCode.ModelRequestAuthMissing
  ) {
    // stream 在 attempt try 内解析请求鉴权，过去会把网络前的类型化
    // 鉴权缺失错误重新归一化为通用请求失败；generate 则直接保留原始协议错误。
    throw error;
  }

  const completedAt = Date.now();
  const retryWithRepairedHistory =
    !state.emittedRetryBoundaryEvent && repairThinkingSignatureRejection(error);
  if (retryWithRepairedHistory) {
    state.statusContext = {
      ...state.statusContext,
      maxAttempts: retryBudgetMaxAttempts(retryBudget, input.retry.maxAttempts + 1),
    };
  }
  const classified = classifyModelFailure(error, input.request.abortSignal);
  if (error instanceof RuntimeHeadersRefreshError) {
    classified.message = error.message;
    classified.retryable = false;
  }
  // off-peak 特判（仅 idle plan provider）：排队 429 豁免预算无限探测；3102 标记落败触发续跑。
  const offPeak = resolveOffPeakFailureDecision({
    offPeak: state.resolved.accountAccess?.mode === "off-peak",
    failure: classified,
    error: unwrapRetryError(error),
  });
  const failure: ClassifiedModelFailure =
    offPeak?.kind === "ticketExpired"
      ? {
          ...classified,
          retryable: false,
          message: offPeakTicketExpiredMessage(classified.message),
        }
      : offPeak?.kind === "queued"
        ? {
            ...classified,
            retryable: true,
            retryReason: ModelRetryReason.OffpeakQueued,
          }
        : classified;
  const errorPhase =
    readModelFailureErrorPhase(error) ??
    (state.streamIterator === undefined ? "prepare" : "stream");
  state.awaitIteratorClose = failure.reason !== ModelFailureReasonValue.Cancelled;
  const responseHeaders = sanitizeModelNetworkHeaders(getResponseHeaders(unwrapRetryError(error)));
  const failureDecision = resolveStreamFailureDecision({
    attempt: state.retryBudgetAttempt,
    emittedRetryBoundaryEvent: state.emittedRetryBoundaryEvent,
    error,
    failure,
    maxAttempts: input.retry.maxAttempts,
    preserveProviderStreamBoundaries: input.request.preserveProviderStreamBoundaries,
    responseHeaders,
    retryBudget: retryBudget,
    streamIteratorCreated: state.streamIterator !== undefined,
    streamErrorChunkObserved: Boolean(
      state.diagnostics.lastErrorChunk || state.diagnostics.lastFinishChunk,
    ),
  });
  // off-peak 排队 429 豁免预算：不消耗 maxAttempts，SSE 可见输出边界仍适用。
  if (offPeak?.kind === "queued" && !state.emittedRetryBoundaryEvent) {
    failureDecision.canRetry = true;
  }
  if (retryWithRepairedHistory) {
    failureDecision.canRetry = true;
  }

  logStreamFailureDiagnostics({
    attempt: state.attempt,
    canRetry: failureDecision.canRetry,
    diagnostics: state.diagnostics,
    durationMs: completedAt - state.startedAt,
    emittedError: state.emittedError,
    emittedEvent: state.emittedEvent,
    emittedRetryBoundaryEvent: state.emittedRetryBoundaryEvent,
    error,
    failure,
    logger: input.logger,
    statusContext: state.statusContext,
  });
  await publishModelStatus(
    {
      ...state.statusContext,
      attempt: state.attempt,
      durationMs: completedAt - state.startedAt,
      message: failure.message,
      reason: failure.reason,
      requestHeaderCount: state.requestHeaderCount,
      requestHeaders: state.requestHeaders,
      responseHeaderCount: Object.keys(responseHeaders).length,
      responseHeaders,
      retryable: failureDecision.canRetry,
      statusCode: failure.statusCode,
      streamOutputCommitted: state.streamOutputCommitted,
      ...modelFailureStatusFields(error, failure, errorPhase),
      timestamp: new Date(completedAt).toISOString(),
      type: "model_request_failed",
    },
    {
      ...statusPublishOptions(input, admission),
      failureError: unwrapRetryError(error),
    },
  );
  state.terminalStatusPublished = true;

  if (retryWithRepairedHistory) {
    await publishRetryScheduledStatus(
      input,
      state.statusContext,
      state.attempt,
      0,
      {
        ...failure,
        retryReason: ModelRetryReason.ReasoningSignatureRepair,
      },
      state.requestHeaders,
      responseHeaders,
      admission,
    );
    return false;
  }

  if (!failureDecision.canRetry) {
    logRetryDelayDecision({
      attempt: state.attempt,
      canRetry: false,
      failure,
      logger: input.logger,
      responseHeaders,
      statusContext: state.statusContext,
    });
    throw toAdapterError(error, failure, state.statusContext, state.attempt, {
      ...failureDecision.context,
      errorPhase,
    });
  }

  const delayMs =
    offPeak?.kind === "queued"
      ? offPeak.delayMs
      : calculateRetryDelay(input.retry, state.retryBudgetAttempt, failure.retryAfterMs);
  logRetryDelayDecision({
    attempt: state.attempt,
    canRetry: failureDecision.canRetry,
    delayMs,
    failure,
    logger: input.logger,
    responseHeaders,
    statusContext: state.statusContext,
  });

  await publishRetryScheduledStatus(
    input,
    state.statusContext,
    state.attempt,
    delayMs,
    failure,
    state.requestHeaders,
    responseHeaders,
    admission,
  );
  // 旧 attempt 的 ticket 与 stream/tee 都必须在 backoff 和 policy gate 前完成释放。
  await closeAttemptBeforeRetryYield();
  try {
    await sleep(delayMs, input.request.abortSignal);
  } catch (sleepError) {
    const sleepFailure = classifyModelFailure(sleepError, input.request.abortSignal);
    await publishModelStatus(
      {
        ...state.statusContext,
        attempt: state.attempt,
        durationMs: Date.now() - state.startedAt,
        message: sleepFailure.message,
        reason: sleepFailure.reason,
        requestHeaderCount: state.requestHeaderCount,
        requestHeaders: state.requestHeaders,
        retryable: false,
        statusCode: sleepFailure.statusCode,
        streamOutputCommitted: state.streamOutputCommitted,
        ...modelFailureStatusFields(sleepError, sleepFailure, "connect"),
        timestamp: new Date().toISOString(),
        type: "model_request_failed",
      },
      {
        // 退避期间票据已归还：这次取消不属于任何一次尝试，不转投票据。
        ...statusPublishOptions(input),
        failureError: unwrapRetryError(sleepError),
      },
    );
    state.terminalStatusPublished = true;
    throw toAdapterError(sleepError, sleepFailure, state.statusContext, state.attempt, {
      errorPhase: "connect",
    });
  }
  // policy 可在 backoff 或下一次 admission/header/status 等待期间被 UI 武装；
  // 保留本次失败，在下一次物理 provider 调用前再做最后一次无 await 判定。
  const finalRetryYieldGate = createDeferredRetryYieldGate(
    {
      attempt: state.attempt,
      canRetry: failureDecision.canRetry,
      consumedRetryAttempts:
        offPeak?.kind === "queued"
          ? Math.max(0, state.retryBudgetAttempt - 1)
          : state.retryBudgetAttempt,
      failure,
      logger: input.logger,
      request: input.request,
      resolved: state.resolved,
    },
    toAdapterError(error, failure, state.statusContext, state.attempt, {
      ...failureDecision.context,
      errorPhase,
      retryYieldedToFailover: true,
    }),
  );
  if (await finalRetryYieldGate.shouldYield()) {
    throw finalRetryYieldGate.adapterError;
  }
  retryState.pendingRetryYield = finalRetryYieldGate;
  return offPeak?.kind === "queued";
}
