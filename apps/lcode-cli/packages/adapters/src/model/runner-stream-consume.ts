import type { ModelStreamEvent } from "@lcode/contracts";
import { canRetryEmptyCompletion } from "./empty-completion-retry.js";
import { type AttemptAdmission } from "./request-admission.js";
import { isZeroOutputModelCompletion } from "./runner-diagnostics.js";
import { publishModelStatus, publishModelTelemetryMilestone } from "./runner-status.js";
import { readNextWithStreamIdleTimeout } from "./stream-idle-timeout.js";

import { statusPublishOptions } from "./runner-attempt-status.js";
import type { ModelRunnerRetryState } from "./runner-request-state.js";
import { compactDirectToolCallCommitEvent } from "./runner-stream-boundary.js";
import { handleStreamChunk } from "./runner-stream-chunk.js";
import {
  observeVisibleStreamEvent,
  publishVisibleMilestones,
} from "./runner-stream-observation.js";
import type { StreamAttemptState, StreamRunnerInput } from "./runner-stream-state.js";

type AttemptState = Pick<
  StreamAttemptState,
  | "attempt"
  | "retryBudgetAttempt"
  | "startedAt"
  | "streamIdleTimeoutMs"
  | "emittedEvent"
  | "emittedRetryBoundaryEvent"
  | "emittedError"
  | "retryScheduledFromStreamChunk"
  | "offPeakQueueHoldFromStreamChunk"
  | "pendingRetrySafeEvents"
  | "diagnostics"
  | "attemptAbortController"
  | "statusContext"
  | "toolCallAssembler"
  | "streamIterator"
  | "streamReachedNaturalEnd"
  | "attemptFailed"
  | "awaitIteratorClose"
  | "requestHeaders"
  | "requestHeaderCount"
  | "timeToFirstProviderEventMs"
  | "timeToFirstContentMs"
  | "timeToFirstTextMs"
  | "streamMaxIdleMs"
  | "streamStallCount"
  | "streamOutputCommitted"
>;
type RetryState = Pick<ModelRunnerRetryState, "emptyCompletionRetryCount" | "pendingRetryYield">;

export async function* consumeStreamAttempt(
  input: StreamRunnerInput,
  retryState: RetryState,
  state: AttemptState,
  admission: AttemptAdmission,
  repairThinkingSignatureRejection: (error: unknown) => boolean,
  closeAttemptBeforeRetryYield: () => Promise<void>,
): AsyncGenerator<ModelStreamEvent> {
  while (true) {
    // prepare 已创建 iterator；唯一清理 owner 只在终止或重试退出路径置空。
    const next = await readNextWithStreamIdleTimeout(state.streamIterator!, {
      abortController: state.attemptAbortController.controller,
      onTimeout: async (error) => {
        state.streamStallCount += 1;
        state.streamMaxIdleMs = Math.max(state.streamMaxIdleMs, error.idleMs);
        await publishModelStatus(
          {
            ...state.statusContext,
            attempt: state.attempt,
            idleMs: error.idleMs,
            message: error.message,
            requestHeaderCount: state.requestHeaderCount,
            requestHeaders: state.requestHeaders,
            timeoutMs: error.timeoutMs,
            timestamp: new Date().toISOString(),
            type: "model_stream_stalled",
          },
          statusPublishOptions(input, admission),
        );
      },
      timeoutMs: state.streamIdleTimeoutMs,
    });
    if (next.done) {
      state.streamReachedNaturalEnd = true;
      break;
    }
    if (state.timeToFirstProviderEventMs === undefined) {
      state.timeToFirstProviderEventMs = Date.now() - state.startedAt;
      await publishModelTelemetryMilestone(
        {
          ...state.statusContext,
          attempt: state.attempt,
          elapsedMs: state.timeToFirstProviderEventMs,
          timestamp: new Date(state.startedAt + state.timeToFirstProviderEventMs).toISOString(),
          type: "model_first_provider_event",
        },
        { logger: input.logger, statusSink: input.statusSink },
      );
    }

    let event: Awaited<ReturnType<typeof handleStreamChunk>>;
    try {
      event = await handleStreamChunk({
        admission,
        attempt: state.attempt,
        chunk: next.value,
        diagnostics: state.diagnostics,
        emittedRetryBoundaryEvent: state.emittedRetryBoundaryEvent,
        beforeRetryYieldEvaluation: closeAttemptBeforeRetryYield,
        input,
        pendingRetrySafeEvents: state.pendingRetrySafeEvents,
        requestHeaderCount: state.requestHeaderCount,
        requestHeaders: state.requestHeaders,
        repairThinkingSignatureRejection,
        retryBudgetAttempt: state.retryBudgetAttempt,
        startedAt: state.startedAt,
        statusContext: state.statusContext,
        toolCallAssembler: state.toolCallAssembler,
      });
    } catch (error) {
      const directToolCommit = compactDirectToolCallCommitEvent(input.request, next.value);
      if (directToolCommit) {
        // 完整 direct tool-call 已是 provider 事件；name/input 校验即使抛错，
        // 也不能让 adapter 当作首事件前失败再次 SSE 重放。
        state.emittedRetryBoundaryEvent = true;
        for (const pendingEvent of state.pendingRetrySafeEvents.splice(0)) {
          state.emittedEvent = true;
          yield pendingEvent;
        }
        // 无 raw message-block provenance 的 provider 可能直接给完整 tool-call。
        // 先把 inferred block stop 交给隐藏 collector，再传播校验错误，避免 HTTP 重放。
        state.emittedEvent = true;
        yield directToolCommit;
      }
      throw error;
    }
    const shouldHoldEmptyCompletionEvents =
      !event.emittedError &&
      event.visibleEvents.some((visibleEvent) => visibleEvent.type === "finish") &&
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
      });
    if (shouldHoldEmptyCompletionEvents) {
      // finish 会把已缓存的 start 一并刷给 core；先暂存到自然 EOF，确认这是
      // generic empty 后再重试，避免第一次 attempt 的 finish/start 泄漏到 UI。
      event.visibleEvents.length = 0;
    }
    state.emittedError = state.emittedError || event.emittedError;
    state.emittedEvent = state.emittedEvent || event.emittedEvent;
    state.emittedRetryBoundaryEvent =
      state.emittedRetryBoundaryEvent || event.emittedRetryBoundaryEvent;

    if (event.retryScheduled) {
      // SSE error chunk 的 retry 是正常控制流，不会进入 catch；
      // 若不显式标记失败，finally 会跳过旧 attempt 的 iterator/tee 清理。
      // 下一次物理请求必须等待本轮 abort 与有界清理后才能启动。
      state.attemptFailed = true;
      state.awaitIteratorClose = true;
      state.retryScheduledFromStreamChunk = true;
      state.offPeakQueueHoldFromStreamChunk = event.offPeakQueueHold;
      retryState.pendingRetryYield = event.deferredRetryYield;
      break;
    }
    if (event.terminalError) {
      throw event.terminalError;
    }
    if (event.visibleEvents.length > 0) {
      for (const visibleEvent of event.visibleEvents) {
        const observation = observeVisibleStreamEvent(visibleEvent, Date.now() - state.startedAt);
        await publishVisibleMilestones(input, state, observation);
        state.streamOutputCommitted = state.streamOutputCommitted || observation.outputCommitted;
        yield visibleEvent;
      }
    }
  }
}
