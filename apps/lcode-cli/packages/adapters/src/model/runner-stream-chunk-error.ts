import { ModelRetryReason } from "@lcode/contracts";
import { classifyModelFailure, type ClassifiedModelFailure } from "./failure-classifier.js";
import { getResponseHeaders, unwrapRetryError } from "./failure-inspection.js";
import { offPeakTicketExpiredMessage, resolveOffPeakFailureDecision } from "./offpeak-retry.js";
import { retryBudgetMaxAttempts } from "./retry-budget.js";
import { createDeferredRetryYieldGate } from "./runner-failover-yield.js";
import { sanitizeModelNetworkHeaders } from "./runner-network-headers.js";
import {
  calculateRetryDelay,
  logRetryDelayDecision,
  sleep,
  TerminalStreamChunkError,
  toAdapterError,
} from "./runner-retry.js";
import { publishModelStatus } from "./runner-status.js";
import { modelFailureStatusFields } from "./runner-telemetry.js";

import { publishRetryScheduledStatus, statusPublishOptions } from "./runner-attempt-status.js";
import { streamChunkResult } from "./runner-stream-boundary.js";
import type { StreamChunkInput, StreamChunkResult } from "./runner-stream-chunk-state.js";
import { resolveStreamFailureDecision } from "./runner-stream-failure-policy.js";

export async function handleStreamErrorEvent(
  input: StreamChunkInput,
  error: unknown,
): Promise<StreamChunkResult> {
  const retryWithRepairedHistory =
    !input.emittedRetryBoundaryEvent && input.repairThinkingSignatureRejection(error);
  const statusContext = retryWithRepairedHistory
    ? {
        ...input.statusContext,
        maxAttempts: retryBudgetMaxAttempts(
          input.input.request.modelRetryBudget,
          input.input.retry.maxAttempts + 1,
        ),
      }
    : input.statusContext;
  const classified = classifyModelFailure(error, input.input.request.abortSignal);
  // off-peak 特判：SSE 首块即错（尚无可见输出）时的排队 429 同样豁免预算重试。
  const offPeak = resolveOffPeakFailureDecision({
    offPeak: input.input.resolved.accountAccess?.mode === "off-peak",
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
  const responseHeaders = sanitizeModelNetworkHeaders(getResponseHeaders(unwrapRetryError(error)));
  const failureDecision = resolveStreamFailureDecision({
    attempt: input.retryBudgetAttempt,
    emittedRetryBoundaryEvent: input.emittedRetryBoundaryEvent,
    error,
    failure,
    maxAttempts: input.input.retry.maxAttempts,
    preserveProviderStreamBoundaries: input.input.request.preserveProviderStreamBoundaries,
    responseHeaders,
    retryBudget: input.input.request.modelRetryBudget,
    streamErrorChunkObserved: true,
  });
  // off-peak 排队 429 豁免预算：不消耗 maxAttempts，SSE 可见输出边界仍适用。
  if (offPeak?.kind === "queued" && !input.emittedRetryBoundaryEvent) {
    failureDecision.canRetry = true;
  }
  if (retryWithRepairedHistory) {
    failureDecision.canRetry = true;
  }
  await publishModelStatus(
    {
      ...statusContext,
      attempt: input.attempt,
      durationMs: Date.now() - input.startedAt,
      message: failure.message,
      reason: failure.reason,
      requestHeaderCount: input.requestHeaderCount,
      requestHeaders: input.requestHeaders,
      responseHeaderCount: Object.keys(responseHeaders).length,
      responseHeaders,
      retryable: failureDecision.canRetry,
      statusCode: failure.statusCode,
      streamOutputCommitted: input.emittedRetryBoundaryEvent,
      ...modelFailureStatusFields(error, failure, "stream"),
      timestamp: new Date().toISOString(),
      type: "model_request_failed",
    },
    {
      ...statusPublishOptions(input.input, input.admission),
      failureError: unwrapRetryError(error),
    },
  );

  if (retryWithRepairedHistory) {
    await publishRetryScheduledStatus(
      input.input,
      statusContext,
      input.attempt,
      0,
      {
        ...failure,
        retryReason: ModelRetryReason.ReasoningSignatureRepair,
      },
      input.requestHeaders,
      responseHeaders,
      input.admission,
    );
    return streamChunkResult({
      emittedError: true,
      retryScheduled: true,
    });
  }

  if (!failureDecision.canRetry) {
    logRetryDelayDecision({
      attempt: input.attempt,
      canRetry: false,
      failure,
      logger: input.input.logger,
      responseHeaders,
      statusContext,
    });
    return streamChunkResult({
      emittedError: true,
      terminalError: new TerminalStreamChunkError(
        toAdapterError(error, failure, statusContext, input.attempt, {
          ...failureDecision.context,
          errorPhase: "stream",
        }),
      ),
    });
  }

  const delayMs =
    offPeak?.kind === "queued"
      ? offPeak.delayMs
      : calculateRetryDelay(input.input.retry, input.retryBudgetAttempt, failure.retryAfterMs);
  logRetryDelayDecision({
    attempt: input.attempt,
    canRetry: failureDecision.canRetry,
    delayMs,
    failure,
    logger: input.input.logger,
    responseHeaders,
    statusContext,
  });

  await publishRetryScheduledStatus(
    input.input,
    statusContext,
    input.attempt,
    delayMs,
    failure,
    input.requestHeaders,
    responseHeaders,
    input.admission,
  );
  // error chunk 仍持有 AI SDK iterator；退避和 policy gate 前必须先关闭旧 attempt。
  await input.beforeRetryYieldEvaluation();
  // Note: AI SDK can surface pre-output APICallError as an error chunk;
  // retry it here so protocol clients still receive the normal apiRetry status updates.
  try {
    await sleep(delayMs, input.input.request.abortSignal);
  } catch (sleepError) {
    const sleepFailure = classifyModelFailure(sleepError, input.input.request.abortSignal);
    // SSE error chunk 在 helper 内等待 retry；取消发生时 iterator 仍存在，
    // 外层仅按 iterator 判断会误记为 stream。先在真实等待边界写入 connect 事实。
    throw toAdapterError(sleepError, sleepFailure, statusContext, input.attempt, {
      errorPhase: "connect",
    });
  }
  const finalRetryYieldGate = createDeferredRetryYieldGate(
    {
      attempt: input.attempt,
      canRetry: failureDecision.canRetry,
      consumedRetryAttempts:
        offPeak?.kind === "queued"
          ? Math.max(0, input.retryBudgetAttempt - 1)
          : input.retryBudgetAttempt,
      failure,
      logger: input.input.logger,
      request: input.input.request,
      resolved: input.input.resolved,
    },
    toAdapterError(error, failure, statusContext, input.attempt, {
      ...failureDecision.context,
      errorPhase: "stream",
      retryYieldedToFailover: true,
    }),
  );
  if (await finalRetryYieldGate.shouldYield()) {
    return streamChunkResult({
      emittedError: true,
      terminalError: new TerminalStreamChunkError(finalRetryYieldGate.adapterError),
    });
  }
  return streamChunkResult({
    deferredRetryYield: finalRetryYieldGate,
    emittedError: true,
    retryScheduled: true,
    offPeakQueueHold: offPeak?.kind === "queued",
  });
}
