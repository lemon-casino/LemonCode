import type { ModelTextResult } from "@lcode/contracts";
import {
  ModelErrorCode,
  ModelFailureReason as ModelFailureReasonValue,
  ModelTransportKind as ModelTransportKindValue,
} from "@lcode/contracts";
import { resolveAnthropicRequestMetadataUserId } from "./anthropic-request-metadata.js";
import {
  canRetryEmptyCompletion,
  createEmptyCompletionFailure,
  scheduleEmptyCompletionRetry,
} from "./empty-completion-retry.js";
import { AiSdkModelAdapterError } from "./errors.js";
import { classifyModelFailure } from "./failure-classifier.js";
import { unwrapRetryError } from "./failure-inspection.js";
import { detectProviderBusinessFinishError } from "./provider-finish-business-error.js";
import { admitAttempt, type AttemptAdmission } from "./request-admission.js";
import {
  normalizeRetryAttemptOffset,
  retryAttemptLoopContinues,
  retryBudgetMaxAttempts,
} from "./retry-budget.js";
import {
  isDevelopmentModelIOEnv,
  recordGenerateTextDebug,
  shouldRecordModelIO,
} from "./runner-debug.js";
import {
  getGenerateTextResultMetadata,
  isZeroOutputModelCompletion,
  logGenerateTextDiagnostics,
} from "./runner-diagnostics.js";
import {
  createDeferredRetryYieldGate,
  RetryYieldBeforeInvocationError,
} from "./runner-failover-yield.js";
import { sanitizeModelNetworkHeaders } from "./runner-network-headers.js";
import {
  normalizeReasoning,
  normalizeSources,
  normalizeToolCalls,
  normalizeToolResults,
  normalizeUsage,
} from "./runner-normalization.js";
import { createGenerateTextOptions } from "./runner-options.js";
import { toAdapterError } from "./runner-retry.js";
import { resolveModelForAttempt } from "./runner-runtime-headers.js";
import {
  admissionWaitPublishers,
  createAttemptStatusContext,
  createStatusContext,
  publishModelStatus,
} from "./runner-status.js";
import { modelFailureStatusFields, providerRequestIdFromHeaders } from "./runner-telemetry.js";

import { statusPublishOptions } from "./runner-attempt-status.js";
import { handleGenerateFailure } from "./runner-generate-failure.js";
import { serializeStructuredOutput, waitForGenerateTextOrAbort } from "./runner-generate-result.js";
import type { GenerateAttemptState } from "./runner-generate-state.js";
import type { ModelRunnerInput, ModelRunnerRetryState } from "./runner-request-state.js";

export async function runGenerateText(input: ModelRunnerInput): Promise<ModelTextResult> {
  // 重试预算档位：workflow actor 的请求带 unbounded，
  // 只放宽瞬态失败的放弃条件；状态事件里的 maxAttempts 以 0 表示无上限。
  const retryBudget = input.request.modelRetryBudget;
  const statusMaxAttempts = (extraAttempts: number): number =>
    retryBudgetMaxAttempts(retryBudget, input.retry.maxAttempts + extraAttempts);
  const baseStatusContext = createStatusContext({
    maxAttempts: statusMaxAttempts(0),
    request: input.request,
    resolved: input.resolved,
    transport: ModelTransportKindValue.Http,
  });
  const recordModelIO =
    input.request.metadata?.skipTranscript !== true && shouldRecordModelIO(input.env);
  const isDev = isDevelopmentModelIOEnv(input.env);
  const retryState: ModelRunnerRetryState = {
    requestMessages: input.request.messages,
    signatureRepairAttempted: false,
    emptyCompletionRetryCount: 0,
    pendingRetryYield: undefined,
  };
  const retryAttemptOffset = normalizeRetryAttemptOffset(input.request.retryAttemptOffset);

  for (
    let attempt = retryAttemptOffset + 1;
    retryAttemptLoopContinues(
      retryBudget,
      attempt,
      input.retry.maxAttempts + Number(retryState.signatureRepairAttempted),
    );
    attempt += 1
  ) {
    const attemptState: GenerateAttemptState = {
      attempt,
      retryBudgetAttempt: attempt - Number(retryState.signatureRepairAttempted),
      attemptRequest: { ...input.request, messages: retryState.requestMessages },
      startedAt: Date.now(),
      resolved: input.resolved,
      statusContext: createAttemptStatusContext(
        {
          ...baseStatusContext,
          maxAttempts: statusMaxAttempts(Number(retryState.signatureRepairAttempted)),
        },
        attempt,
      ),
      options: undefined,
      requestInvocationCompleted: false,
      requestHeaders: {},
      requestHeaderCount: 0,
    };

    // 进程级准入：每次尝试发出前等槽位，
    // 票据在本次尝试结束时归还（成功 / 失败 / 抛出都经 finally；退避 sleep 之前先归还）。等待中被
    // 取消 → 与 sleep 被取消同一条路：记 connect 阶段的 cancelled 失败，抛出。
    let admission: AttemptAdmission;
    try {
      admission = await admitAttempt({
        admission: input.request.modelRequestAdmission,
        model: {
          providerId: String(attemptState.resolved.providerId),
          modelId: String(attemptState.resolved.modelId),
        },
        signal: input.request.abortSignal,
        ...admissionWaitPublishers(
          attemptState.statusContext,
          attempt,
          statusPublishOptions(input),
        ),
      });
    } catch (admitError) {
      const admitFailure = classifyModelFailure(admitError, input.request.abortSignal);
      await publishModelStatus(
        {
          ...attemptState.statusContext,
          attempt,
          message: admitFailure.message,
          reason: admitFailure.reason,
          requestHeaderCount: attemptState.requestHeaderCount,
          requestHeaders: attemptState.requestHeaders,
          retryable: false,
          statusCode: admitFailure.statusCode,
          ...modelFailureStatusFields(admitError, admitFailure, "connect"),
          timestamp: new Date().toISOString(),
          type: "model_request_failed",
        },
        {
          ...statusPublishOptions(input),
          failureError: unwrapRetryError(admitError),
        },
      );
      throw toAdapterError(admitError, admitFailure, attemptState.statusContext, attempt, {
        errorPhase: "connect",
      });
    }

    try {
      attemptState.resolved = await resolveModelForAttempt({
        attempt,
        request: attemptState.attemptRequest,
        resolveModel: input.resolveModel,
      });
      const anthropicMetadataUserId = await resolveAnthropicRequestMetadataUserId({
        env: input.env,
        providerKind: attemptState.resolved.providerKind,
        sessionId: attemptState.statusContext.sessionId,
      });
      attemptState.options = createGenerateTextOptions({
        anthropicMetadataUserId,
        env: input.env,
        includeModelIO: recordModelIO,
        request: attemptState.attemptRequest,
        resolved: attemptState.resolved,
        statusContext: attemptState.statusContext,
      });
      attemptState.requestHeaders = sanitizeModelNetworkHeaders(attemptState.options.headers);
      attemptState.requestHeaderCount = Object.keys(attemptState.requestHeaders).length;
      await publishModelStatus(
        {
          ...attemptState.statusContext,
          attempt,
          requestHeaderCount: attemptState.requestHeaderCount,
          requestHeaders: attemptState.requestHeaders,
          timestamp: new Date(attemptState.startedAt).toISOString(),
          type: "model_request_started",
        },
        statusPublishOptions(input, admission),
      );

      const finalRetryYieldGate = retryState.pendingRetryYield;
      retryState.pendingRetryYield = undefined;
      if (finalRetryYieldGate && (await finalRetryYieldGate.shouldYield())) {
        // decision=false 时当前 ticket 直接保护物理调用；只有明确让渡才释放并闭合已发布的 started。
        admission.release();
        await publishModelStatus(
          {
            ...attemptState.statusContext,
            attempt,
            durationMs: Date.now() - attemptState.startedAt,
            errorCode: ModelErrorCode.ModelRequestCancelled,
            errorPhase: "prepare",
            exceptionType: RetryYieldBeforeInvocationError.name,
            message: "Model retry yielded to execution failover before provider invocation.",
            reason: ModelFailureReasonValue.Cancelled,
            requestHeaderCount: attemptState.requestHeaderCount,
            requestHeaders: attemptState.requestHeaders,
            retryable: false,
            timestamp: new Date().toISOString(),
            type: "model_request_failed",
          },
          statusPublishOptions(input, admission),
        );
        throw new RetryYieldBeforeInvocationError(finalRetryYieldGate.adapterError);
      }
      // final gate、header/status sink 都可能异步等待；取消若在等待中到达，
      // 不能仅依赖 Provider 自己识别已 aborted signal 后再多发一次物理请求。
      input.request.abortSignal?.throwIfAborted();
      // 部分非流式 provider/fetch 兼容层收到 AbortSignal 后不会及时 settle
      // generateText promise，导致 runtime 已 Stop，goal verifier 仍要等上游自然返回才收口。
      // adapter 是本地取消契约边界：signal 一旦 abort 就立即拒绝，迟到 provider 结果只丢弃。
      const pendingResult = input.runtime.generateText(attemptState.options);
      // options 构造成功不等于 runtime 已接受请求；同步 setup 异常会在调用点直接抛出。
      // 只有 generateText 调用返回 pending promise 后才进入 response 归因边界，避免把本地 setup 记成 provider。
      attemptState.requestInvocationCompleted = true;
      const result = await waitForGenerateTextOrAbort(pendingResult, input.request.abortSignal);
      const responseHeaders = sanitizeModelNetworkHeaders(
        getGenerateTextResultMetadata(result)?.response?.headers,
      );
      const providerBusinessFinishError = detectProviderBusinessFinishError({
        providerId: String(attemptState.resolved.providerId),
        providerKind: attemptState.resolved.providerKind,
        source: {
          finishReason: result.finishReason,
          providerMetadata: result.providerMetadata,
          rawFinishReason: (result.providerMetadata as Record<string, unknown> | undefined)
            ?.rawFinishReason,
          response: (result as unknown as { response?: unknown }).response,
        },
      });
      if (providerBusinessFinishError) {
        throw providerBusinessFinishError;
      }
      const usage = normalizeUsage(result.totalUsage ?? result.usage);
      const toolCalls = normalizeToolCalls(result, input.logger);
      const toolResults = normalizeToolResults(result, toolCalls);
      const sources = normalizeSources(result);
      const text = input.request.responseJsonSchema
        ? serializeStructuredOutput(result)
        : result.text;
      const reasoning = normalizeReasoning(result.reasoning);
      const reasoningLength = (reasoning ?? []).reduce(
        (total, block) => total + block.text.length,
        0,
      );
      if (
        input.request.preserveProviderStreamBoundaries !== true &&
        isZeroOutputModelCompletion({
          finishReason: result.finishReason,
          reasoningLength,
          textLength: text.length,
          toolCallCount: toolCalls?.length ?? 0,
          usage,
        }) &&
        canRetryEmptyCompletion({
          abortSignal: input.request.abortSignal,
          attempt,
          maxAttempts: input.retry.maxAttempts,
          retryCount: retryState.emptyCompletionRetryCount,
        })
      ) {
        const completedAt = Date.now();
        // 空 completion 是 provider promise 正常 resolve，不会进入异常重试 catch；
        // 必须在 adapter 返回前识别并重试一次，否则 core 只能收到最终空响应错误。
        logGenerateTextDiagnostics({
          attempt,
          completedAt,
          logger: input.logger,
          result,
          startedAt: attemptState.startedAt,
          statusContext: attemptState.statusContext,
          toolCallCount: toolCalls?.length ?? 0,
          usage,
        });
        retryState.emptyCompletionRetryCount += 1;
        // 正常 resolve 的空 completion 也进入 backoff；不能在等待 policy 或 sleep 时占用物理请求票据。
        admission.release();
        await scheduleEmptyCompletionRetry({
          abortSignal: input.request.abortSignal,
          attempt,
          completedAt,
          errorPhase: "response",
          logger: input.logger,
          requestHeaders: attemptState.requestHeaders,
          requestStatusSink: input.request.statusSink,
          responseHeaders,
          retry: input.retry,
          retryBudgetAttempt: attemptState.retryBudgetAttempt,
          startedAt: attemptState.startedAt,
          statusContext: attemptState.statusContext,
          statusSink: input.statusSink,
        });
        const emptyFailure = createEmptyCompletionFailure();
        const emptyRetryYieldGate = createDeferredRetryYieldGate(
          {
            attempt,
            canRetry: true,
            consumedRetryAttempts: attemptState.retryBudgetAttempt,
            failure: emptyFailure,
            logger: input.logger,
            request: input.request,
            resolved: attemptState.resolved,
          },
          toAdapterError(
            new Error(emptyFailure.message),
            emptyFailure,
            attemptState.statusContext,
            attempt,
            {
              errorPhase: "response",
              retryYieldedToFailover: true,
            },
          ),
        );
        if (await emptyRetryYieldGate.shouldYield()) {
          throw new RetryYieldBeforeInvocationError(emptyRetryYieldGate.adapterError);
        }
        retryState.pendingRetryYield = emptyRetryYieldGate;
        continue;
      }
      const completedAt = Date.now();

      recordGenerateTextDebug({
        modelIoFullRetentionEnabled: input.modelIoFullRetentionEnabled,
        attempt,
        debugDir: input.debugDir,
        isDev,
        normalizedToolCalls: toolCalls,
        options: attemptState.options,
        recordModelIO,
        request: attemptState.attemptRequest,
        requestId: attemptState.statusContext.requestId,
        resolved: attemptState.resolved,
        result,
        startedAt: attemptState.startedAt,
      });
      logGenerateTextDiagnostics({
        attempt,
        completedAt,
        logger: input.logger,
        result,
        statusContext: attemptState.statusContext,
        startedAt: attemptState.startedAt,
        toolCallCount: toolCalls?.length ?? 0,
        usage,
      });
      await publishModelStatus(
        {
          ...attemptState.statusContext,
          attempt,
          durationMs: completedAt - attemptState.startedAt,
          finishReason: result.finishReason,
          requestHeaderCount: attemptState.requestHeaderCount,
          requestHeaders: attemptState.requestHeaders,
          responseHeaderCount: Object.keys(responseHeaders).length,
          responseHeaders,
          providerRequestId: providerRequestIdFromHeaders(responseHeaders),
          timestamp: new Date(completedAt).toISOString(),
          type: "model_request_completed",
          usage,
        },
        statusPublishOptions(input, admission),
      );

      return {
        text,
        finishReason: result.finishReason,
        usage,
        reasoning,
        toolCalls,
        toolResults,
        sources,
        providerMetadata: result.providerMetadata as Record<string, unknown> | undefined,
      };
    } catch (error) {
      const offPeakQueueHold = await handleGenerateFailure(
        input,
        retryState,
        attemptState,
        admission,
        error,
        { recordModelIO, isDev },
        retryBudget,
      );
      if (offPeakQueueHold) attempt -= 1;
    } finally {
      admission.release();
    }
  }

  throw new AiSdkModelAdapterError(
    ModelErrorCode.ModelRequestFailed,
    "Model request failed before an attempt could complete",
    { context: { requestId: baseStatusContext.requestId } },
  );
}
