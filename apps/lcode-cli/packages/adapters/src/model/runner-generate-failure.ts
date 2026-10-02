import {
  ModelErrorCode,
  ModelProtocolError,
  ModelRetryReason,
  type ModelRetryBudget,
} from "@lcode/contracts";
import type { ClassifiedModelFailure } from "./failure-classifier.js";
import { classifyModelFailure, inspectProviderFailure } from "./failure-classifier.js";
import { getResponseHeaders, unwrapRetryError } from "./failure-inspection.js";
import { offPeakTicketExpiredMessage, resolveOffPeakFailureDecision } from "./offpeak-retry.js";
import { repairReasoningHistoryAfterSignatureRejection } from "./reasoning-history-normalization.js";
import { type AttemptAdmission } from "./request-admission.js";
import { retryBudgetAllows, retryBudgetMaxAttempts } from "./retry-budget.js";
import { recordGenerateTextDebug } from "./runner-debug.js";
import {
  createDeferredRetryYieldGate,
  RetryYieldBeforeInvocationError,
} from "./runner-failover-yield.js";
import { sanitizeModelNetworkHeaders } from "./runner-network-headers.js";
import {
  calculateRetryDelay,
  logRetryDelayDecision,
  sleep,
  toAdapterError,
} from "./runner-retry.js";
import { RuntimeHeadersRefreshError } from "./runner-runtime-headers.js";
import { publishModelStatus } from "./runner-status.js";
import { modelFailureStatusFields } from "./runner-telemetry.js";
import { retryAllowedByFailurePolicy } from "./workflow-model-failure-policy.js";

import { publishRetryScheduledStatus, statusPublishOptions } from "./runner-attempt-status.js";
import type { GenerateAttemptState } from "./runner-generate-state.js";
import type { ModelRunnerInput, ModelRunnerRetryState } from "./runner-request-state.js";

// helper 借用本次 attempt 与 request 重试字段；票据仍由 runner 的 finally 兜底归还。
export async function handleGenerateFailure(
  input: ModelRunnerInput,
  retryState: Pick<
    ModelRunnerRetryState,
    "signatureRepairAttempted" | "requestMessages" | "pendingRetryYield"
  >,
  attemptState: GenerateAttemptState,
  admission: AttemptAdmission,
  error: unknown,
  debug: { recordModelIO: boolean; isDev: boolean },
  retryBudget: ModelRetryBudget | undefined,
): Promise<boolean> {
  if (error instanceof RetryYieldBeforeInvocationError) {
    throw error.adapterError;
  }
  // 合并后鉴权解析进入 attempt try；与 stream 一致保留网络前凭据缺失的类型化错误。
  if (error instanceof ModelProtocolError && error.code === ModelErrorCode.ModelRequestAuthMissing)
    throw error;
  const completedAt = Date.now();
  const classified = classifyModelFailure(error, input.request.abortSignal);
  if (error instanceof RuntimeHeadersRefreshError) {
    classified.message = error.message;
    classified.retryable = false;
  }
  // off-peak 特判（仅 idle plan provider，见 offpeak-retry.ts）：排队 429 豁免预算、
  // 3102（兼容旧 3001）以稳定标记落败触发 desktop 侧续跑。
  const offPeak = resolveOffPeakFailureDecision({
    offPeak: attemptState.resolved.accountAccess?.mode === "off-peak",
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
        ? { ...classified, retryable: true, retryReason: ModelRetryReason.OffpeakQueued }
        : classified;
  const responseHeaders = sanitizeModelNetworkHeaders(getResponseHeaders(unwrapRetryError(error)));
  const repairedMessages =
    !retryState.signatureRepairAttempted && attemptState.resolved.providerKind === "anthropic"
      ? repairReasoningHistoryAfterSignatureRejection(retryState.requestMessages, error)
      : undefined;
  const retryWithRepairedHistory = repairedMessages !== undefined;
  if (repairedMessages) {
    // 签名只对生成它的 thinking block 有效。明确收到签名校验 400 时，
    // 只替换本次请求副本，并给一次不占普通 retry 预算的物理请求机会；不能通过
    // 回退 attempt 复用 requestId，也不能改写 canonical history。
    retryState.signatureRepairAttempted = true;
    retryState.requestMessages = repairedMessages;
    attemptState.statusContext = {
      ...attemptState.statusContext,
      maxAttempts: retryBudgetMaxAttempts(retryBudget, input.retry.maxAttempts + 1),
    };
  }
  const canRetryWithFailurePolicy =
    offPeak?.kind === "queued"
      ? true
      : retryBudgetAllows(retryBudget, attemptState.retryBudgetAttempt, input.retry.maxAttempts) &&
        // workflow 流量（无上限预算）读策略表而不是分类器的 retryable；有界预算逐字不变。
        retryAllowedByFailurePolicy(
          failure,
          retryBudget,
          inspectProviderFailure(error).providerErrorCode,
        );
  const canRetry = retryWithRepairedHistory || canRetryWithFailurePolicy;

  if (attemptState.options) {
    recordGenerateTextDebug({
      modelIoFullRetentionEnabled: input.modelIoFullRetentionEnabled,
      attempt: attemptState.attempt,
      debugDir: input.debugDir,
      error,
      isDev: debug.isDev,
      normalizedToolCalls: undefined,
      options: attemptState.options,
      recordModelIO: debug.recordModelIO,
      request: attemptState.attemptRequest,
      requestId: attemptState.statusContext.requestId,
      resolved: attemptState.resolved,
      startedAt: attemptState.startedAt,
    });
  }
  await publishModelStatus(
    {
      ...attemptState.statusContext,
      attempt: attemptState.attempt,
      durationMs: completedAt - attemptState.startedAt,
      message: failure.message,
      reason: failure.reason,
      requestHeaderCount: attemptState.requestHeaderCount,
      requestHeaders: attemptState.requestHeaders,
      responseHeaderCount: Object.keys(responseHeaders).length,
      responseHeaders,
      retryable: canRetry,
      statusCode: failure.statusCode,
      ...modelFailureStatusFields(error, failure, attemptState.options ? "response" : "prepare"),
      timestamp: new Date(completedAt).toISOString(),
      type: "model_request_failed",
    },
    {
      ...statusPublishOptions(input, admission),
      failureError: unwrapRetryError(error),
    },
  );

  if (!canRetry) {
    logRetryDelayDecision({
      attempt: attemptState.attempt,
      canRetry: false,
      failure,
      logger: input.logger,
      responseHeaders,
      statusContext: attemptState.statusContext,
    });
    throw toAdapterError(error, failure, attemptState.statusContext, attemptState.attempt, {
      errorPhase: attemptState.requestInvocationCompleted ? "response" : "prepare",
    });
  }

  if (retryWithRepairedHistory) {
    input.logger?.warn("Retrying model request after thinking signature rejection", {
      attempt: attemptState.attempt,
      event: "model.reasoning_signature_repair.retry",
      maxAttempts: attemptState.statusContext.maxAttempts,
      nextAttempt: attemptState.attempt + 1,
      requestId: attemptState.statusContext.requestId,
      status: "waiting",
    });
    await publishRetryScheduledStatus(
      input,
      attemptState.statusContext,
      attemptState.attempt,
      0,
      {
        ...failure,
        retryReason: ModelRetryReason.ReasoningSignatureRepair,
      },
      attemptState.requestHeaders,
      responseHeaders,
      admission,
    );
    return false;
  }

  const delayMs =
    offPeak?.kind === "queued"
      ? offPeak.delayMs
      : calculateRetryDelay(input.retry, attemptState.retryBudgetAttempt, failure.retryAfterMs);
  logRetryDelayDecision({
    attempt: attemptState.attempt,
    canRetry,
    delayMs,
    failure,
    logger: input.logger,
    responseHeaders,
    statusContext: attemptState.statusContext,
  });

  await publishRetryScheduledStatus(
    input,
    attemptState.statusContext,
    attemptState.attempt,
    delayMs,
    failure,
    attemptState.requestHeaders,
    responseHeaders,
    admission,
  );

  // 退避期间不持票：槽位让给别人，重试再准入。
  admission.release();
  try {
    await sleep(delayMs, input.request.abortSignal);
  } catch (sleepError) {
    const sleepFailure = classifyModelFailure(sleepError, input.request.abortSignal);
    const sleepResponseHeaders = sanitizeModelNetworkHeaders(
      getResponseHeaders(unwrapRetryError(sleepError)),
    );
    await publishModelStatus(
      {
        ...attemptState.statusContext,
        attempt: attemptState.attempt,
        message: sleepFailure.message,
        reason: sleepFailure.reason,
        requestHeaderCount: attemptState.requestHeaderCount,
        requestHeaders: attemptState.requestHeaders,
        responseHeaderCount: Object.keys(sleepResponseHeaders).length,
        responseHeaders: sleepResponseHeaders,
        retryable: false,
        statusCode: sleepFailure.statusCode,
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
    throw toAdapterError(
      sleepError,
      sleepFailure,
      attemptState.statusContext,
      attemptState.attempt,
      {
        errorPhase: "connect",
      },
    );
  }
  // 用户可能在 retry backoff 或下一次 admission/header/status 等待期间才选择新供应商。
  // 先在退避结束快速判定，再把同一失败保留到物理调用前做最终判定。
  const finalRetryYieldGate = createDeferredRetryYieldGate(
    {
      attempt: attemptState.attempt,
      canRetry,
      consumedRetryAttempts:
        offPeak?.kind === "queued"
          ? Math.max(0, attemptState.retryBudgetAttempt - 1)
          : attemptState.retryBudgetAttempt,
      failure,
      logger: input.logger,
      request: input.request,
      resolved: attemptState.resolved,
      // 签名拒绝分支已提前返回，由 runner 唯一放行修复请求；修复请求若仍失败，
      // 必须恢复 failover gate，避免 unbounded workflow 永久锁在失效供应商。
    },
    toAdapterError(error, failure, attemptState.statusContext, attemptState.attempt, {
      errorPhase: attemptState.requestInvocationCompleted ? "response" : "prepare",
      retryYieldedToFailover: true,
    }),
  );
  if (await finalRetryYieldGate.shouldYield()) {
    throw finalRetryYieldGate.adapterError;
  }
  retryState.pendingRetryYield = finalRetryYieldGate;
  return offPeak?.kind === "queued";
}
