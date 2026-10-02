import { ModelErrorCode, ModelFailureReason as ModelFailureReasonValue } from "@lcode/contracts";
import { resolveAnthropicRequestMetadataUserId } from "./anthropic-request-metadata.js";
import { type AttemptAdmission } from "./request-admission.js";
import { RetryYieldBeforeInvocationError } from "./runner-failover-yield.js";
import { sanitizeModelNetworkHeaders } from "./runner-network-headers.js";
import { createStreamTextOptions } from "./runner-options.js";
import { resolveModelForAttempt } from "./runner-runtime-headers.js";
import { publishModelStatus } from "./runner-status.js";

import { statusPublishOptions } from "./runner-attempt-status.js";
import type { ModelRunnerRetryState } from "./runner-request-state.js";
import type {
  StreamAttemptState,
  StreamDebugOptions,
  StreamRunnerInput,
} from "./runner-stream-state.js";

type AttemptState = Pick<
  StreamAttemptState,
  | "attempt"
  | "startedAt"
  | "attemptAbortController"
  | "attemptRequest"
  | "statusContext"
  | "streamIterator"
  | "options"
  | "result"
  | "requestHeaders"
  | "requestHeaderCount"
  | "resolved"
>;
type RetryState = Pick<ModelRunnerRetryState, "pendingRetryYield">;

export async function prepareStreamAttempt(
  input: StreamRunnerInput,
  retryState: RetryState,
  state: AttemptState,
  admission: AttemptAdmission,
  debug: StreamDebugOptions,
): Promise<void> {
  state.resolved = await resolveModelForAttempt({
    attempt: state.attempt,
    request: state.attemptRequest,
    resolveModel: input.resolveModel,
  });
  const anthropicMetadataUserId = await resolveAnthropicRequestMetadataUserId({
    env: input.env,
    providerKind: state.resolved.providerKind,
    sessionId: state.statusContext.sessionId,
  });
  state.options = createStreamTextOptions({
    anthropicMetadataUserId,
    env: input.env,
    includeModelIO: debug.recordModelIO,
    request: state.attemptRequest,
    resolved: state.resolved,
    statusContext: state.statusContext,
  });
  state.requestHeaders = sanitizeModelNetworkHeaders(state.options.headers);
  state.requestHeaderCount = Object.keys(state.requestHeaders).length;
  await publishModelStatus(
    {
      ...state.statusContext,
      attempt: state.attempt,
      requestHeaderCount: state.requestHeaderCount,
      requestHeaders: state.requestHeaders,
      timestamp: new Date(state.startedAt).toISOString(),
      type: "model_request_started",
    },
    statusPublishOptions(input, admission),
  );
  const finalRetryYieldGate = retryState.pendingRetryYield;
  retryState.pendingRetryYield = undefined;
  if (finalRetryYieldGate && (await finalRetryYieldGate.shouldYield())) {
    admission.release();
    await publishModelStatus(
      {
        ...state.statusContext,
        attempt: state.attempt,
        durationMs: Date.now() - state.startedAt,
        errorCode: ModelErrorCode.ModelRequestCancelled,
        errorPhase: "prepare",
        exceptionType: RetryYieldBeforeInvocationError.name,
        message: "Model retry yielded to execution failover before provider invocation.",
        reason: ModelFailureReasonValue.Cancelled,
        requestHeaderCount: state.requestHeaderCount,
        requestHeaders: state.requestHeaders,
        retryable: false,
        streamOutputCommitted: false,
        timestamp: new Date().toISOString(),
        type: "model_request_failed",
      },
      statusPublishOptions(input, admission),
    );
    throw new RetryYieldBeforeInvocationError(finalRetryYieldGate.adapterError);
  }
  // final gate 等异步准备期间可能收到取消；物理 stream 调用前必须再次检查，
  // 不能把已经 aborted 的 signal 交给 Provider 后寄希望于其自行短路。
  state.attemptAbortController.signal.throwIfAborted();
  const streamResult = input.runtime.streamText(state.options);
  state.result = streamResult;
  state.streamIterator = streamResult.fullStream[Symbol.asyncIterator]();
}
