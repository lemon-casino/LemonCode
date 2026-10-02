import type { ModelStreamEvent } from "@lcode/contracts";
import {
  canRetryEmptyCompletion,
  createEmptyCompletionFailure,
  scheduleEmptyCompletionRetry,
} from "./empty-completion-retry.js";
import { classifyModelFailure } from "./failure-classifier.js";
import { detectProviderBusinessFinishError } from "./provider-finish-business-error.js";
import { type AttemptAdmission } from "./request-admission.js";
import { recordStreamTextDebug } from "./runner-debug.js";
import {
  isSuspiciousStreamDiagnostics,
  isZeroOutputModelCompletion,
  logStreamDiagnostics,
} from "./runner-diagnostics.js";
import {
  createDeferredRetryYieldGate,
  RetryYieldBeforeInvocationError,
} from "./runner-failover-yield.js";
import { TerminalStreamChunkError, toAdapterError } from "./runner-retry.js";
import { publishModelStatus } from "./runner-status.js";
import { providerRequestIdFromHeaders } from "./runner-telemetry.js";

import { statusPublishOptions } from "./runner-attempt-status.js";
import type { ModelRunnerRetryState } from "./runner-request-state.js";
import { applyStreamEventsToRetryBoundary } from "./runner-stream-boundary.js";
import { compactStreamFailureContext } from "./runner-stream-failure-policy.js";
import {
  observeVisibleStreamEvent,
  publishVisibleMilestones,
} from "./runner-stream-observation.js";
import { resolveStreamResponseHeaders } from "./runner-stream-response.js";
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
  | "pendingRetrySafeEvents"
  | "diagnostics"
  | "attemptRequest"
  | "statusContext"
  | "toolCallAssembler"
  | "terminalStatusPublished"
  | "options"
  | "result"
  | "requestHeaders"
  | "requestHeaderCount"
  | "resolved"
  | "timeToFirstProviderEventMs"
  | "timeToFirstContentMs"
  | "timeToFirstTextMs"
  | "streamMaxIdleMs"
  | "streamStallCount"
  | "streamOutputCommitted"
>;
type RetryState = Pick<ModelRunnerRetryState, "emptyCompletionRetryCount" | "pendingRetryYield">;

export async function* completeStreamAttempt(
  input: StreamRunnerInput,
  retryState: RetryState,
  state: AttemptState,
  admission: AttemptAdmission,
  debug: StreamDebugOptions,
): AsyncGenerator<ModelStreamEvent, boolean> {
  const flushedEvents = applyStreamEventsToRetryBoundary({
    emittedRetryBoundaryEvent: state.emittedRetryBoundaryEvent,
    events: state.toolCallAssembler.flush(),
    pendingRetrySafeEvents: state.pendingRetrySafeEvents,
    preserveProviderStreamBoundaries: input.request.preserveProviderStreamBoundaries,
  });
  state.emittedEvent = state.emittedEvent || flushedEvents.emittedEvent;
  state.emittedRetryBoundaryEvent =
    state.emittedRetryBoundaryEvent || flushedEvents.emittedRetryBoundaryEvent;
  if (flushedEvents.visibleEvents.length > 0) {
    for (const visibleEvent of flushedEvents.visibleEvents) {
      const observation = observeVisibleStreamEvent(visibleEvent, Date.now() - state.startedAt);
      await publishVisibleMilestones(input, state, observation);
      state.streamOutputCommitted = state.streamOutputCommitted || observation.outputCommitted;
      yield visibleEvent;
    }
  }

  for (const pendingEvent of state.pendingRetrySafeEvents.splice(0)) {
    state.emittedEvent = true;
    const observation = observeVisibleStreamEvent(pendingEvent, Date.now() - state.startedAt);
    await publishVisibleMilestones(input, state, observation);
    state.streamOutputCommitted = state.streamOutputCommitted || observation.outputCommitted;
    yield pendingEvent;
  }

  if (!state.emittedError) {
    // 自然 EOF 后合成的业务错误会通过 TerminalStreamChunkError 直接离开外层 catch；
    // compact 上下文在普通主链路为空，因此必须在合成现场显式保留 stream 阶段。
    // 先识别 provider business error，再考虑 generic empty；否则额度等
    // HTTP 200 空流会被误判成可重试的暂时性空响应。
    const hiddenProviderBusinessError = detectProviderBusinessFinishError({
      providerId: String(state.statusContext.providerId),
      providerKind: state.statusContext.providerKind,
      source:
        state.diagnostics.lastFinishChunk ??
        ({
          type: "finish",
          finishReason: state.diagnostics.finishReason,
          rawFinishReason: state.diagnostics.rawFinishReason,
        } satisfies Record<string, unknown>),
    });
    if (hiddenProviderBusinessError) {
      const failure = classifyModelFailure(hiddenProviderBusinessError, input.request.abortSignal);
      throw new TerminalStreamChunkError(
        toAdapterError(hiddenProviderBusinessError, failure, state.statusContext, state.attempt, {
          ...compactStreamFailureContext(
            input.request.preserveProviderStreamBoundaries,
            "response_body",
          ),
          errorPhase: "stream",
        }),
      );
    }

    if (isSuspiciousStreamDiagnostics(state.diagnostics)) {
      // 403 JSON 等业务错误有时不会让 AI SDK 抛出 error chunk，流会以空 completion 结束；
      // 若不在 adapter 层终止，core 会误报 “Model returned no text...”。
      const streamEndedWithoutOutputError = detectProviderBusinessFinishError({
        providerId: String(state.statusContext.providerId),
        providerKind: state.statusContext.providerKind,
        source: state.diagnostics.lastErrorChunk ?? state.diagnostics.lastFinishChunk,
      });
      if (streamEndedWithoutOutputError) {
        const failure = classifyModelFailure(
          streamEndedWithoutOutputError,
          input.request.abortSignal,
        );
        throw new TerminalStreamChunkError(
          toAdapterError(
            streamEndedWithoutOutputError,
            failure,
            state.statusContext,
            state.attempt,
            {
              ...compactStreamFailureContext(
                input.request.preserveProviderStreamBoundaries,
                "response_body",
              ),
              errorPhase: "stream",
            },
          ),
        );
      }

      if (
        input.request.preserveProviderStreamBoundaries !== true &&
        isZeroOutputModelCompletion({
          finishReason: state.diagnostics.finishReason,
          reasoningLength: state.diagnostics.reasoningDeltaChars,
          textLength: state.diagnostics.textDeltaChars,
          toolCallCount: state.diagnostics.toolCallCount,
          usage: state.diagnostics.usage,
        }) &&
        canRetryEmptyCompletion({
          abortSignal: input.request.abortSignal,
          attempt: state.attempt,
          maxAttempts: input.retry.maxAttempts,
          retryCount: retryState.emptyCompletionRetryCount,
        })
      ) {
        const responseHeaders = await resolveStreamResponseHeaders(state.result!);
        const completedAt = Date.now();
        // finish 会把 retry-safe 前奏刷成可见事件；空 completion 需在
        // flush 前进入一次 adapter retry，避免 core 把第一次 attempt 当成已完成。
        logStreamDiagnostics({
          attempt: state.attempt,
          diagnostics: state.diagnostics,
          durationMs: completedAt - state.startedAt,
          emittedError: state.emittedError,
          emittedEvent: state.emittedEvent,
          logger: input.logger,
          outboundHeaders: state.resolved.headers,
          statusContext: state.statusContext,
        });
        retryState.emptyCompletionRetryCount += 1;
        admission.release();
        await scheduleEmptyCompletionRetry({
          abortSignal: input.request.abortSignal,
          attempt: state.attempt,
          completedAt,
          errorPhase: "stream",
          logger: input.logger,
          requestHeaders: state.requestHeaders,
          requestStatusSink: input.request.statusSink,
          responseHeaders,
          retry: input.retry,
          retryBudgetAttempt: state.retryBudgetAttempt,
          startedAt: state.startedAt,
          statusContext: state.statusContext,
          statusSink: input.statusSink,
          streamOutputCommitted: false,
        });
        const emptyFailure = createEmptyCompletionFailure();
        const emptyRetryYieldGate = createDeferredRetryYieldGate(
          {
            attempt: state.attempt,
            canRetry: true,
            consumedRetryAttempts: state.retryBudgetAttempt,
            failure: emptyFailure,
            logger: input.logger,
            request: input.request,
            resolved: state.resolved,
          },
          toAdapterError(
            new Error(emptyFailure.message),
            emptyFailure,
            state.statusContext,
            state.attempt,
            {
              errorPhase: "stream",
              retryYieldedToFailover: true,
            },
          ),
        );
        if (await emptyRetryYieldGate.shouldYield()) {
          throw new RetryYieldBeforeInvocationError(emptyRetryYieldGate.adapterError);
        }
        retryState.pendingRetryYield = emptyRetryYieldGate;
        return true;
      }
    }
  }

  logStreamDiagnostics({
    attempt: state.attempt,
    diagnostics: state.diagnostics,
    durationMs: Date.now() - state.startedAt,
    emittedError: state.emittedError,
    emittedEvent: state.emittedEvent,
    logger: input.logger,
    outboundHeaders: state.resolved.headers,
    statusContext: state.statusContext,
  });
  if (!state.emittedError) {
    const completedAt = Date.now();
    const responseHeaders = await resolveStreamResponseHeaders(state.result!);
    await publishModelStatus(
      {
        ...state.statusContext,
        attempt: state.attempt,
        durationMs: completedAt - state.startedAt,
        requestHeaderCount: state.requestHeaderCount,
        requestHeaders: state.requestHeaders,
        responseHeaderCount: Object.keys(responseHeaders).length,
        responseHeaders,
        providerRequestId: providerRequestIdFromHeaders(responseHeaders),
        finishReason: state.diagnostics.finishReason,
        usage: state.diagnostics.usage,
        timeToFirstProviderEventMs: state.timeToFirstProviderEventMs,
        timeToFirstContentMs: state.timeToFirstContentMs,
        timeToFirstTextMs: state.timeToFirstTextMs,
        streamMaxIdleMs: state.streamMaxIdleMs || undefined,
        streamStallCount: state.streamStallCount,
        streamOutputCommitted: state.streamOutputCommitted,
        timestamp: new Date(completedAt).toISOString(),
        type: "model_request_completed",
      },
      statusPublishOptions(input, admission),
    );
    state.terminalStatusPublished = true;
  }
  if (debug.recordModelIO && state.options) {
    await recordStreamTextDebug({
      modelIoFullRetentionEnabled: input.modelIoFullRetentionEnabled,
      attempt: state.attempt,
      debugDir: input.debugDir,
      isDev: debug.isDev,
      normalizedToolCalls: state.toolCallAssembler.snapshotNormalizedToolCalls(),
      options: state.options,
      recordModelIO: debug.recordModelIO,
      request: state.attemptRequest,
      requestId: state.statusContext.requestId,
      resolved: state.resolved,
      result: state.result!,
      startedAt: state.startedAt,
    });
  }
  return false;
}
