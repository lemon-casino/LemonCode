import { traceContextToLogContext, TurnMachineImpl } from "../deps.js";
import { createRuntimeAssistantEntry } from "../../agent/message-history.js";
import {
  projectExecutionErrorPayload,
  throwIfTurnAborted,
  isModelContextExceededError,
  isTurnCancellationError,
} from "../helpers/index.js";
import type { RuntimeModelStreamSnapshot } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { persistCancelledStreamSnapshot } from "./cancelled-stream-persistence.js";
import {
  beginStartPlanBusyAdmissionRetryAttempt,
  createStartPlanBusyAutoRetryExhaustedError,
  emitStreamRecoveryRetryEvents,
  emitStreamRecoveryStarted,
  getStartPlanBusyAdmissionRetryDelayMs,
  isStartPlanBusyStreamRecoveryFailure,
} from "./streaming-recovery.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import { recordModelHistoryRound } from "./turn-loop-state.js";
import { recordMainTurnModelUsage } from "./turn-model-step-usage.js";
import {
  commitTurnRequestEntries,
  completeOutputTokenRecovery,
  hasAssistantReasoningContent,
} from "./turn-output-token-continuation.js";
import {
  activateExecutionFailoverAtSafeBoundary,
  canActivateExecutionFailoverAtSafeBoundary,
  classifyExecutionFailoverFailure,
  hasExecutionFailoverTarget,
  isExecutionFailoverRetryYieldClaimCurrent,
  markExecutionFailoverUnsafe,
  readExecutionFailoverRetryYieldClaim,
} from "./model-failover-router.js";
import type {
  ModelStepExecution,
  ModelStepOptions,
  ModelStepResult,
} from "./turn-model-step-types.js";
import {
  closeFailedModelStepAndActivateFailover,
  closeRetryYieldRecoveryStepIfNeeded,
  retainRetryYieldContinuation,
} from "./turn-model-step-failover.js";
import { recoverModelStepAfterContextExceeded } from "./turn-model-step-compact.js";

export async function recoverFailedModelStep(
  this: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  options: ModelStepOptions,
  execution: ModelStepExecution,
  failure: {
    error: unknown;
    latestStreamSnapshot: RuntimeModelStreamSnapshot;
    failedRequestId: string | undefined;
  },
): Promise<ModelStepResult> {
  const {
    assistantCreatedAt,
    assistantMessageId,
    executionModelSelection,
    getRetryRequestIdentity,
    model,
    modelStartedAt,
    modelStepIndex,
    modelTraceContext,
    networkEventStartIndex,
    streamingToolCoordinator,
  } = execution;
  const { error, latestStreamSnapshot, failedRequestId } = failure;
  let finalError = error;
  await recordMainTurnModelUsage(this, state, {
    assistantMessageId,
    error: finalError,
    model,
    modelTraceContext,
    networkEventStartIndex,
    startedAt: modelStartedAt,
    status: state.turnAbortSignal.aborted ? "cancelled" : "error",
  });
  const failoverReason = classifyExecutionFailoverFailure(error, state.turnAbortSignal);
  const retryYieldClaim = readExecutionFailoverRetryYieldClaim(error);
  const retryYieldClaimWasCurrent = retryYieldClaim
    ? isExecutionFailoverRetryYieldClaimCurrent(this, retryYieldClaim)
    : false;
  const eligibleFailureFailover =
    failoverReason !== undefined &&
    failoverReason !== "provider.context_capacity" &&
    hasExecutionFailoverTarget(this, state) &&
    canActivateExecutionFailoverAtSafeBoundary(this, state, failoverReason);
  const shouldAttemptFailureFailover = eligibleFailureFailover || retryYieldClaim !== undefined;
  const toolCallCountBeforeStreamRecovery = state.toolCallCount;
  const streamRecovery = await streamingToolCoordinator.recoverFromModelFailure(
    error,
    assistantCreatedAt,
    {
      ...(failedRequestId ? { failedRequestId } : {}),
      ...(shouldAttemptFailureFailover ? { allowProviderFailover: true } : {}),
    },
  );
  if (!streamRecovery.failoverSafe) markExecutionFailoverUnsafe(this, state);
  if (streamRecovery.recovered) {
    if (state.toolCallCount > toolCallCountBeforeStreamRecovery) {
      completeOutputTokenRecovery(state.turnRequestState);
    }
    if (shouldAttemptFailureFailover && streamRecovery.failoverSafe && failoverReason) {
      const activation = await activateExecutionFailoverAtSafeBoundary(this, state, {
        reasonCode: failoverReason,
        traceContext: modelTraceContext,
      });
      if (activation !== "activated" && retryYieldClaim) {
        retainRetryYieldContinuation(state, retryYieldClaim, model, getRetryRequestIdentity());
      }
      if (
        activation !== "activated" &&
        streamRecovery.providerFailoverOverrideUsed &&
        retryYieldClaim === undefined
      ) {
        throw finalError;
      }
    }
    return "continue";
  }
  if (shouldAttemptFailureFailover && streamRecovery.failoverSafe && failoverReason) {
    await streamingToolCoordinator.abandon("model_failed");
    const failover = await closeFailedModelStepAndActivateFailover.call(this, state, {
      assistantCreatedAt,
      assistantMessageId,
      model,
      modelTraceContext,
      reasonCode: failoverReason,
    });
    if (failover.activated) {
      return "continue";
    }
    if (retryYieldClaim) {
      const claimStillCurrent = isExecutionFailoverRetryYieldClaimCurrent(this, retryYieldClaim);
      // decision 之后入队的新目标可能在真正激活时已不兼容。Adapter 已永久停止 A 的
      // 内部 retry，此处必须把失败 step 收口并重开 A；同 source 的动态能力变化也同样恢复。
      this.logger?.info("Recovering original model after a retry-yield claim could not activate", {
        claimStillCurrent,
        claimWasCurrent: retryYieldClaimWasCurrent,
        event: "model.failover.retry_yield_recovered",
        module: "core.runtime",
        policyRevision: retryYieldClaim.policyRevision,
        sourceCommandId: retryYieldClaim.sourceCommandId,
      });
      retainRetryYieldContinuation(state, retryYieldClaim, model, getRetryRequestIdentity());
      await closeRetryYieldRecoveryStepIfNeeded.call(this, state, {
        assistantCreatedAt,
        assistantMessageId,
        failedStepClosed: failover.failedStepClosed,
        model,
        modelTraceContext,
      });
      return "continue";
    }
  }
  const admissionRetryDelayMs = getStartPlanBusyAdmissionRetryDelayMs({
    error: finalError,
    providerId: executionModelSelection.providerId,
    state,
    turnNumber: this.turnNumber,
  });
  if (!state.turnAbortSignal.aborted && admissionRetryDelayMs !== undefined) {
    // 第二轮及以后 Start Plan 可能在首 token 前被 admission 并发限制拒绝；
    // 这时没有文本或 tool anchor，旧 stream recovery 不会启动，必须关闭空 assistant 后短重试。
    const recoveryAttempt = beginStartPlanBusyAdmissionRetryAttempt(state);
    this.logger?.warn("Main turn retrying after Start Plan admission busy", {
      ...traceContextToLogContext(modelTraceContext),
      event: "model.main_turn.retry_start_plan_admission_busy",
      module: "core.runtime",
      retryDelayMs: admissionRetryDelayMs,
      retryNumber: recoveryAttempt.retryNumber,
      maxRetries: recoveryAttempt.maxRetries,
      status: "waiting",
    });
    await emitStreamRecoveryStarted(
      this,
      state,
      {
        assistantMessageId,
        ...(failedRequestId ? { failedRequestId } : {}),
        traceContext: modelTraceContext,
      },
      finalError,
      recoveryAttempt,
    );
    await this.persistAssistantMessage(
      assistantMessageId,
      state.userMessageId,
      assistantCreatedAt,
      {
        completed: Date.now(),
        finish: "start_plan_admission_retry_discarded",
      },
      modelTraceContext,
      model,
    );
    state.modelResponse = "";
    state.modelStepCount += 1;
    recordModelHistoryRound(state);
    state.turnMachine = new TurnMachineImpl(state.turnMachine.receiveModelResponse(""));
    state.turnMachine = new TurnMachineImpl(state.turnMachine.aggregateResults());
    await emitStreamRecoveryRetryEvents(
      this,
      state,
      {
        assistantMessageId,
        ...(failedRequestId ? { failedRequestId } : {}),
        traceContext: modelTraceContext,
      },
      {
        ...recoveryAttempt,
        discardedReasoningBytes: 0,
        discardedTextBytes: 0,
        reason: "no_tool_committed",
        toolCallIds: [],
      },
    );
    await streamingToolCoordinator.abandon("model_failed");
    await new Promise((resolve) => setTimeout(resolve, admissionRetryDelayMs));
    throwIfTurnAborted(state.turnAbortSignal);
    return "continue";
  }
  if (
    state.streamRecoveryRetryCount > 0 &&
    !state.turnAbortSignal.aborted &&
    isStartPlanBusyStreamRecoveryFailure(finalError)
  ) {
    // Start Plan 运行中断流会先走 core stream recovery；恢复次数耗尽后，
    // 继续抛原 provider 文案会和首轮繁忙失败无法区分，UI 也就不能展示“自动重试达到最大次数”。
    finalError = createStartPlanBusyAutoRetryExhaustedError(finalError);
  }
  await streamingToolCoordinator.abandon(
    state.turnAbortSignal.aborted ? "cancelled" : "model_failed",
  );
  if (state.turnAbortSignal.aborted && isTurnCancellationError(finalError, state.turnAbortSignal)) {
    await persistCancelledStreamSnapshot(this, {
      assistantCreatedAt,
      assistantMessageId,
      snapshot: latestStreamSnapshot,
      traceContext: modelTraceContext,
    });
    const reasoning = latestStreamSnapshot.reasoning.filter(hasAssistantReasoningContent);
    if (latestStreamSnapshot.text.length > 0 || reasoning.length > 0) {
      // 取消时 durable snapshot 已经持久化，但成功路径的 live history commit
      // 和 historyRoundCount 不会执行，导致当前进程与 cold resume 的 provider history 不一致。
      commitTurnRequestEntries(this, state.turnRequestState, [
        createRuntimeAssistantEntry(
          latestStreamSnapshot.text,
          undefined,
          reasoning,
          state.model
            ? { providerId: state.model.providerId, modelId: state.model.modelId }
            : undefined,
        ),
      ]);
      recordModelHistoryRound(state);
    }
  }
  const finalErrorRecord =
    finalError && typeof finalError === "object"
      ? (finalError as Record<string, unknown>)
      : undefined;
  const persistedErrorCode =
    typeof finalErrorRecord?.code === "string" ? finalErrorRecord.code : undefined;
  const persistedErrorProjection = projectExecutionErrorPayload(finalError);
  const persistedTurnResult = isTurnCancellationError(finalError, state.turnAbortSignal)
    ? "cancelled"
    : undefined;
  await this.persistAssistantMessage(
    assistantMessageId,
    state.userMessageId,
    assistantCreatedAt,
    {
      completed: Date.now(),
      error: {
        name: finalError instanceof Error ? finalError.name : "UnknownError",
        data: {
          message: finalError instanceof Error ? finalError.message : String(finalError),
          ...(persistedErrorCode ? { code: persistedErrorCode } : {}),
          // live TurnError 有结构化归因，但 transcript 过去未持久化，冷恢复后会丢成 runtime。
          ...(persistedErrorProjection.attribution
            ? { attribution: persistedErrorProjection.attribution }
            : {}),
          // 用户 Stop 的模型中止过去只持久化通用 error name/message，
          // cold hydration 无法区分正常取消和真实 provider 失败，最终错误地生成 TurnError。
          ...(persistedTurnResult ? { turnResult: persistedTurnResult } : {}),
        },
      },
    },
    modelTraceContext,
    model,
  );
  if (isModelContextExceededError(finalError)) {
    if (
      await recoverModelStepAfterContextExceeded.call(
        this,
        state,
        finalError,
        modelStepIndex,
        options.requestEntries,
      )
    ) {
      return "continue";
    }
    if (
      streamRecovery.failoverSafe &&
      hasExecutionFailoverTarget(this, state) &&
      (
        await closeFailedModelStepAndActivateFailover.call(this, state, {
          assistantCreatedAt,
          assistantMessageId,
          model,
          modelTraceContext,
          reasonCode: "provider.context_capacity",
        })
      ).activated
    ) {
      return "continue";
    }
  }
  throw finalError;
}
