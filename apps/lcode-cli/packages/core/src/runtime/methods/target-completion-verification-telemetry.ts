import type { SessionGoal, TraceContext } from "../deps.js";
import { isTurnCancellationError } from "../helpers/turn-errors.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { TargetCompletionVerificationResult } from "./target-completion-verification.js";

export async function runTargetCompletionVerificationWithTelemetry(
  runtime: AgentRuntimeInternal,
  input: {
    abortSignal?: AbortSignal;
    target: SessionGoal;
    traceContext: TraceContext;
  },
  execute: () => Promise<TargetCompletionVerificationResult>,
): Promise<TargetCompletionVerificationResult> {
  const scope = runtime.agentTelemetry.detached({
    executionKind: "foreground",
    operation: "goal_completion_verification",
    targetKind: "goal",
    trigger: "turn",
    traceContext: input.traceContext,
  });
  return scope.run(async () => {
    try {
      const result = await execute();
      scope.setResultType("boolean");
      scope.finishCompleted();
      return result;
    } catch (error) {
      if (isTurnCancellationError(error, input.abortSignal)) {
        scope.finishCancelled("abort_signal");
      } else {
        scope.finishFailed("execute", "unknown", error);
      }
      throw error;
    }
  });
}
