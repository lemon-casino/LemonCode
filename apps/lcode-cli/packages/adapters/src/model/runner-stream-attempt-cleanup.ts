import { ModelFailureReason as ModelFailureReasonValue } from "@lcode/contracts";
import { type AttemptAdmission } from "./request-admission.js";
import { publishModelStatus } from "./runner-status.js";

import { statusPublishOptions } from "./runner-attempt-status.js";
import { closeStreamIteratorBestEffort } from "./runner-stream-cleanup.js";
import type { StreamAttemptState, StreamRunnerInput } from "./runner-stream-state.js";

type AttemptState = Pick<
  StreamAttemptState,
  | "attempt"
  | "startedAt"
  | "emittedError"
  | "attemptAbortController"
  | "statusContext"
  | "streamIterator"
  | "streamReachedNaturalEnd"
  | "attemptFailed"
  | "awaitIteratorClose"
  | "terminalStatusPublished"
  | "result"
  | "requestHeaders"
  | "requestHeaderCount"
  | "streamOutputCommitted"
>;

export async function closeAttemptBeforeRetryYield(
  input: Pick<StreamRunnerInput, "logger">,
  state: AttemptState,
  admission: AttemptAdmission,
): Promise<void> {
  admission.release();
  if (!state.streamIterator || state.streamReachedNaturalEnd) return;
  state.attemptFailed = true;
  state.awaitIteratorClose = true;
  if (!state.attemptAbortController.signal.aborted) {
    state.attemptAbortController.controller.abort(
      new Error("Model stream attempt yielded before its retry."),
    );
  }
  await closeStreamIteratorBestEffort(state.streamIterator, {
    attempt: state.attempt,
    logger: input.logger,
    result: state.result,
  });
  state.streamIterator = undefined;
}

export async function cleanupStreamAttempt(
  input: Pick<StreamRunnerInput, "logger" | "request" | "statusSink">,
  state: AttemptState,
  admission: AttemptAdmission,
): Promise<void> {
  if (
    !state.streamReachedNaturalEnd &&
    (state.attemptFailed || input.request.preserveProviderStreamBoundaries === true)
  ) {
    // 普通 stream 的 429 retry 失败若不进入本清理分支，
    // AI SDK fullStream tee 会持有旧 provider 请求，连续重试会让后续物理请求卡在发送前。
    // 失败 attempt 必须无条件中止并释放；普通 consumer 主动提前结束仍保持原语义。
    if (!state.attemptAbortController.signal.aborted) {
      state.attemptAbortController.controller.abort(
        new Error("Model stream attempt ended before natural EOF."),
      );
    }
    if (!state.attemptFailed && !state.terminalStatusPublished && !state.emittedError) {
      // consumer 侧的校验异常只会触发 AsyncIteratorClose，不会回到上面的 catch；
      // 将已启动的物理请求收口为 cancelled，避免 fallback 前遗留悬空 started 状态。
      const completedAt = Date.now();
      await publishModelStatus(
        {
          ...state.statusContext,
          attempt: state.attempt,
          durationMs: completedAt - state.startedAt,
          message: "Model stream consumer closed before natural EOF.",
          reason: ModelFailureReasonValue.Cancelled,
          requestHeaderCount: state.requestHeaderCount,
          requestHeaders: state.requestHeaders,
          retryable: false,
          errorCode: "model_request_cancelled",
          errorPhase: "stream",
          exceptionType: "AbortError",
          streamOutputCommitted: state.streamOutputCommitted,
          timestamp: new Date(completedAt).toISOString(),
          type: "model_request_failed",
        },
        statusPublishOptions(input, admission),
      );
    }
    if (state.attemptFailed && state.awaitIteratorClose) {
      await closeStreamIteratorBestEffort(state.streamIterator, {
        attempt: state.attempt,
        logger: input.logger,
        result: state.result,
      });
    } else {
      void closeStreamIteratorBestEffort(state.streamIterator, {
        attempt: state.attempt,
        logger: input.logger,
      });
    }
  } else if (state.attemptAbortController.signal.aborted) {
    // 普通 main 保留既有生命周期：只有 caller/idle 已经 abort 时才 best-effort 关闭 iterator。
    void closeStreamIteratorBestEffort(state.streamIterator, {
      attempt: state.attempt,
      logger: input.logger,
    });
  }
  state.attemptAbortController.cleanup();
  // 兜底归还（成功 / 抛出 / 消费者提前 return 都到这里）；正常失败路径已在 sleep 前归还，幂等。
  admission.release();
}
