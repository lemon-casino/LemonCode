import { runWithModelInvocationContext, traceContextToLogContext } from "../deps.js";
import type { Model, SessionEvent, TraceContext } from "../deps.js";
import { buildRuntimeProviderRequestMessages, throwIfTurnAborted } from "../helpers/index.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { createRefreshRuntimeHeadersBeforeModelAttempt } from "./model-runtime-headers.js";
import { resolveModelRequestSessionTypeFromTaskType } from "./model-request-session-type.js";
import { isStartPlanBusyStreamRecoveryFailure } from "./streaming-recovery.js";

const TARGET_VERIFIER_START_PLAN_BUSY_RETRY_DELAYS_MS = [1_000, 2_000] as const;
const START_PLAN_TARGET_VERIFIER_RETRY_PROVIDER_IDS = new Set([
  "account:bigmodel-start-plan",
  "account:zai-start-plan",
]);

/** The verifier caller owns lifecycle and evidence; this helper executes its frozen model request. */
export async function generateTargetCompletionVerificationText(
  this: AgentRuntimeInternal,
  input: {
    abortSignal?: AbortSignal;
    events: SessionEvent[];
    messages: ReturnType<typeof buildRuntimeProviderRequestMessages>["messages"];
    model: Model;
    traceContext: TraceContext;
  },
) {
  const maxAttempts = TARGET_VERIFIER_START_PLAN_BUSY_RETRY_DELAYS_MS.length + 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const invocationContext = {
        metadata: traceContextToLogContext(input.traceContext),
        modelRequestSessionType: resolveModelRequestSessionTypeFromTaskType(this.config.taskType),
        modelCall: {
          operation: "goal_completion_verification" as const,
        },
        statusSink: this.createModelStatusSink(input.traceContext, input.events),
        traceContext: input.traceContext,
        refreshRuntimeHeadersBeforeAttempt: createRefreshRuntimeHeadersBeforeModelAttempt(this, {
          abortSignal: input.abortSignal,
          model: input.model,
          traceContext: input.traceContext,
        }),
      };
      return await runWithModelInvocationContext(invocationContext, () =>
        input.model.generateText({
          abortSignal: input.abortSignal,
          messages: input.messages,
          // Verifier 继承已绑定的思考配置，不能套用低成本辅助调用的降档和封顶策略。
          options: { maxOutputTokens: input.model.optionSpecs.maxOutputTokens.max },
          tools: [],
        }),
      );
    } catch (error) {
      const retryDelayMs = TARGET_VERIFIER_START_PLAN_BUSY_RETRY_DELAYS_MS[attempt - 1];
      if (
        input.abortSignal?.aborted ||
        retryDelayMs === undefined ||
        !isTargetVerifierStartPlanBusyFailure(error, input.model.providerId)
      ) {
        throw error;
      }

      // 目标完成验证发生在用户已看到 assistant 迭代之后；Start Plan busy
      // 是 admission 瞬时并发。先短暂重试，避免直接走 fail-open 把可恢复并发误当完成。
      this.logger?.warn("Goal completion verification retrying after Start Plan busy", {
        ...traceContextToLogContext(input.traceContext),
        attempt,
        event: "target.completion_verification.retry_start_plan_busy",
        maxAttempts,
        module: "core.runtime",
        retryDelayMs,
        status: "waiting",
      });
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      throwIfTurnAborted(input.abortSignal);
    }
  }

  throw new Error("Goal completion verification retry loop exhausted unexpectedly.");
}

function isTargetVerifierStartPlanBusyFailure(error: unknown, providerId: string): boolean {
  return (
    START_PLAN_TARGET_VERIFIER_RETRY_PROVIDER_IDS.has(providerId) &&
    isStartPlanBusyStreamRecoveryFailure(error)
  );
}
