import { classifyModelFailure } from "./failure-classifier.js";
import { unwrapRetryError } from "./failure-inspection.js";
import { admitAttempt, type AttemptAdmission } from "./request-admission.js";
import { toAdapterError } from "./runner-retry.js";
import { admissionWaitPublishers, publishModelStatus } from "./runner-status.js";
import { modelFailureStatusFields } from "./runner-telemetry.js";

import { statusPublishOptions } from "./runner-attempt-status.js";
import type { StreamAttemptState, StreamRunnerInput } from "./runner-stream-state.js";

type AttemptState = Pick<
  StreamAttemptState,
  | "attempt"
  | "startedAt"
  | "attemptAbortController"
  | "statusContext"
  | "requestHeaders"
  | "requestHeaderCount"
  | "resolved"
  | "streamOutputCommitted"
>;

export async function admitStreamAttempt(
  input: Pick<StreamRunnerInput, "logger" | "request" | "statusSink">,
  state: AttemptState,
): Promise<AttemptAdmission> {
  // 进程级准入：每次尝试发出前等槽位，
  // 票据在本次尝试结束时归还（成功 / 失败 / 抛出 / 消费者放弃流都经 finally；退避 sleep 之前先归还）。
  // 等待中被取消 → 与 sleep 被取消同一条路：记 connect 阶段的 cancelled 失败，抛出。
  try {
    return await admitAttempt({
      admission: input.request.modelRequestAdmission,
      model: {
        providerId: String(state.resolved.providerId),
        modelId: String(state.resolved.modelId),
      },
      signal: input.request.abortSignal,
      ...admissionWaitPublishers(state.statusContext, state.attempt, statusPublishOptions(input)),
    });
  } catch (admitError) {
    state.attemptAbortController.cleanup();
    const admitFailure = classifyModelFailure(admitError, input.request.abortSignal);
    await publishModelStatus(
      {
        ...state.statusContext,
        attempt: state.attempt,
        durationMs: Date.now() - state.startedAt,
        message: admitFailure.message,
        reason: admitFailure.reason,
        requestHeaderCount: state.requestHeaderCount,
        requestHeaders: state.requestHeaders,
        retryable: false,
        statusCode: admitFailure.statusCode,
        streamOutputCommitted: state.streamOutputCommitted,
        ...modelFailureStatusFields(admitError, admitFailure, "connect"),
        timestamp: new Date().toISOString(),
        type: "model_request_failed",
      },
      {
        ...statusPublishOptions(input),
        failureError: unwrapRetryError(admitError),
      },
    );
    throw toAdapterError(admitError, admitFailure, state.statusContext, state.attempt, {
      errorPhase: "connect",
    });
  }
}
