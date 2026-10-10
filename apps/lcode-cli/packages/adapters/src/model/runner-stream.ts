import type { ModelStreamEvent } from "@lcode/contracts";
import { ModelTransportKind as ModelTransportKindValue } from "@lcode/contracts";
import {
  normalizeRetryAttemptOffset,
  retryAttemptLoopContinues,
  retryBudgetMaxAttempts,
} from "./retry-budget.js";
import { isDevelopmentModelIOEnv, shouldRecordModelIO } from "./runner-debug.js";
import { createStreamDiagnostics } from "./runner-diagnostics.js";
import { createAttemptStatusContext, createStatusContext } from "./runner-status.js";
import {
  createLinkedAbortController,
  resolveModelStreamIdleTimeoutMs,
} from "./stream-idle-timeout.js";
import { StreamingToolCallAssembler } from "./streaming-tool-call-assembler.js";

import type { ModelRunnerRetryState } from "./runner-request-state.js";
import { admitStreamAttempt } from "./runner-stream-admission.js";
import {
  cleanupStreamAttempt,
  closeAttemptBeforeRetryYield,
} from "./runner-stream-attempt-cleanup.js";
import { completeStreamAttempt } from "./runner-stream-completion.js";
import { consumeStreamAttempt } from "./runner-stream-consume.js";
import { handleStreamFailure } from "./runner-stream-failure.js";
import { prepareStreamAttempt } from "./runner-stream-prepare.js";
import { repairStreamThinkingSignature } from "./runner-stream-signature-repair.js";
import type { StreamAttemptState, StreamRunnerInput } from "./runner-stream-state.js";

export async function* runStreamText(input: StreamRunnerInput): AsyncGenerator<ModelStreamEvent> {
  // 重试预算档位：只放宽瞬态失败的放弃条件；
  // `emittedRetryBoundaryEvent` 之后不重试的规则不变。状态事件 maxAttempts 以 0 表示无上限。
  const retryBudget = input.request.modelRetryBudget;
  const statusMaxAttempts = (extraAttempts: number): number =>
    retryBudgetMaxAttempts(retryBudget, input.retry.maxAttempts + extraAttempts);
  const baseStatusContext = createStatusContext({
    maxAttempts: statusMaxAttempts(0),
    request: input.request,
    resolved: input.resolved,
    transport: ModelTransportKindValue.Sse,
  });
  const recordModelIO = shouldRecordModelIO(input.env);
  const isDev = isDevelopmentModelIOEnv(input.env);
  const retryState: ModelRunnerRetryState = {
    requestMessages: input.request.messages,
    signatureRepairAttempted: false,
    emptyCompletionRetryCount: 0,
    pendingRetryYield: undefined,
  };
  const retryAttemptOffset = normalizeRetryAttemptOffset(input.request.retryAttemptOffset);
  // off-peak 排队会回退逻辑 attempt；物理序号独立递增，避免复用 ID 绕过请求预算。
  let physicalAttempt = retryAttemptOffset;

  for (
    let attempt = retryAttemptOffset + 1;
    retryAttemptLoopContinues(
      retryBudget,
      attempt,
      input.retry.maxAttempts + Number(retryState.signatureRepairAttempted),
    );
    attempt += 1
  ) {
    const retryBudgetAttempt = attempt - Number(retryState.signatureRepairAttempted);
    const startedAt = Date.now();
    // 每次 retry 沿用原先的递增 idle 窗口，不能由 helper 自行重置。
    const streamIdleTimeoutMs = resolveModelStreamIdleTimeoutMs({
      baseTimeoutMs: input.streamIdleTimeoutMs,
      retryNumber: (input.request.streamIdleTimeoutRetryNumber ?? 0) + retryBudgetAttempt - 1,
    });
    const diagnostics = createStreamDiagnostics();
    const attemptAbortController = createLinkedAbortController(input.request.abortSignal);
    const attemptRequest = {
      ...input.request,
      abortSignal: attemptAbortController.signal,
      messages: retryState.requestMessages,
    };
    const statusContext = createAttemptStatusContext(
      {
        ...baseStatusContext,
        maxAttempts: statusMaxAttempts(Number(retryState.signatureRepairAttempted)),
      },
      ++physicalAttempt,
    );
    const toolCallAssembler = new StreamingToolCallAssembler({ logger: input.logger });
    const state: StreamAttemptState = {
      attempt,
      retryBudgetAttempt,
      startedAt,
      streamIdleTimeoutMs,
      diagnostics,
      attemptAbortController,
      attemptRequest,
      statusContext,
      toolCallAssembler,
      emittedEvent: false,
      emittedRetryBoundaryEvent: false,
      emittedError: false,
      retryScheduledFromStreamChunk: false,
      offPeakQueueHoldFromStreamChunk: false,
      pendingRetrySafeEvents: [],
      streamIterator: undefined,
      streamReachedNaturalEnd: false,
      attemptFailed: false,
      awaitIteratorClose: false,
      terminalStatusPublished: false,
      options: undefined,
      result: undefined,
      requestHeaders: {},
      requestHeaderCount: 0,
      resolved: input.resolved,
      timeToFirstProviderEventMs: undefined,
      timeToFirstContentMs: undefined,
      timeToFirstTextMs: undefined,
      streamMaxIdleMs: 0,
      streamStallCount: 0,
      streamOutputCommitted: false,
    };
    const repairThinkingSignatureRejection = (error: unknown): boolean =>
      repairStreamThinkingSignature(input, retryState, state, error);
    const admission = await admitStreamAttempt(input, state);
    const closeBeforeRetryYield = (): Promise<void> =>
      closeAttemptBeforeRetryYield(input, state, admission);
    const debug = { recordModelIO, isDev };

    try {
      await prepareStreamAttempt(input, retryState, state, admission, debug);
      yield* consumeStreamAttempt(
        input,
        retryState,
        state,
        admission,
        repairThinkingSignatureRejection,
        closeBeforeRetryYield,
      );
      if (state.retryScheduledFromStreamChunk) {
        if (state.offPeakQueueHoldFromStreamChunk) attempt -= 1;
        continue;
      }
      const retryEmptyCompletion = yield* completeStreamAttempt(
        input,
        retryState,
        state,
        admission,
        debug,
      );
      if (retryEmptyCompletion) continue;
      return;
    } catch (error) {
      const offPeakQueueHold = await handleStreamFailure(
        input,
        retryState,
        state,
        admission,
        error,
        debug,
        repairThinkingSignatureRejection,
        closeBeforeRetryYield,
        retryBudget,
      );
      if (offPeakQueueHold) attempt -= 1;
    } finally {
      // off-peak 分支先回退循环计数；清理日志仍读取原 finally 可见的同一计数。
      state.attempt = attempt;
      await cleanupStreamAttempt(input, state, admission);
    }
  }
}
