import {
  SessionEventType,
  failedGoalCompletionVerification,
  goalAcceptanceHash,
  type GoalCompletionVerificationOutput,
  type SessionGoal,
  type TraceContext,
  type GoalEvidenceHeadToken,
} from "@lcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";
import type { TargetCompletionVerificationResult } from "./target-completion-verification.js";
import { readGoalEvidenceSnapshot } from "../../goal/evidence.js";
import { runtimeGoalEvidenceOwner } from "./goal-evidence-events.js";

export async function runGoalVerifierBoundary(
  runtime: AgentRuntimeInternal,
  input: {
    target: SessionGoal;
    traceContext: TraceContext;
    abortSignal?: AbortSignal;
  },
  verify: () => Promise<GoalCompletionVerificationOutput>,
): Promise<GoalCompletionVerificationOutput> {
  try {
    return await verify();
  } catch (error) {
    if (!input.target.acceptance) throw error;
    if (input.abortSignal?.aborted) {
      await runtime.pauseActiveTargetForCancellation(input.traceContext);
      throw error;
    }
    const verification = failedGoalCompletionVerification(
      "Strict completion verification could not initialize or read execution evidence.",
    );
    const projection = await runtime.rebuildProjection();
    const latest = projection.targetCompletionVerificationTimeline
      .filter((item) => item.targetId === input.target.targetID)
      .at(-1);
    const goalIteration =
      latest?.status === "started" ? latest.goalIteration : (latest?.goalIteration ?? 0) + 1;
    const verificationId =
      latest?.status === "started"
        ? latest.verificationId
        : `goal_incomplete_${input.traceContext.traceId}_${goalIteration}`;
    if (latest?.status !== "started")
      await runtime.appendEvent(
        runtime.createEvent(
          SessionEventType.TargetCompletionVerification,
          {
            targetId: input.target.targetID,
            verificationId,
            goalIteration,
            status: "started",
          },
          input.traceContext,
        ),
        input.traceContext,
      );
    await runtime.appendEvent(
      runtime.createEvent(
        SessionEventType.TargetCompletionVerification,
        {
          targetId: input.target.targetID,
          verificationId,
          goalIteration,
          status: "failed_closed",
          verification,
        },
        input.traceContext,
      ),
      input.traceContext,
    );
    return verification;
  }
}

export async function commitVerifiedGoalCompletion(
  runtime: AgentRuntimeInternal,
  input: {
    target: SessionGoal;
    traceContext: TraceContext;
    abortSignal?: AbortSignal;
    generation: number;
    foregroundExecutionId?: string;
  },
  verification: GoalCompletionVerificationOutput,
): Promise<TargetCompletionVerificationResult> {
  if (!verification.passed) return { target: input.target, verification };
  const previousTarget = await runtime.readSessionTargetForContext(input.traceContext);
  const strict = input.target.acceptance?.policy === "strict";
  let evidenceHeads: GoalEvidenceHeadToken[] | undefined;
  if (strict) {
    // 核验后的另一笔写入或 Stop/替换不能借用旧 passed；提交前重读内容和唯一目标。
    const evidence = await readGoalEvidenceSnapshot(runtimeGoalEvidenceOwner(runtime), input.target);
    evidenceHeads = evidence?.evidenceHeads;
    if (
      input.abortSignal?.aborted ||
      input.generation !== runtime.branchGeneration ||
      input.foregroundExecutionId !== runtime.activeForegroundExecution?.foregroundExecutionId ||
      previousTarget?.targetID !== input.target.targetID ||
      previousTarget.status !== "active" ||
      evidence?.summary.outcome !== "pass"
    ) {
      return rejectStrictCompletion(
        runtime,
        input.target,
        input.traceContext,
        "Goal or execution evidence changed before strict completion commit.",
      );
    }
  }
  const updatedTarget = await runtime.sessionStore!.updateTargetStatus({
    sessionID: runtime.sessionId,
    status: "complete",
    ...(strict
      ? {
          expected: {
            targetID: input.target.targetID,
            updatedAt: input.target.time.updated,
            stateRevision: input.target.stateRevision,
            acceptanceHash: goalAcceptanceHash(input.target.acceptance!),
            // 同一 digest snapshot 的 head token 交给 SQL，堵住读取证据与 UPDATE 间的新 attempt。
            evidenceHeads,
          },
        }
      : {}),
  });
  if (!updatedTarget && strict)
    return rejectStrictCompletion(
      runtime,
      input.target,
      input.traceContext,
      "Goal version changed before completion commit.",
    );
  const completedTarget = updatedTarget ?? input.target;
  await runtime.recordTargetChanged({
    action: "status_updated",
    previousTarget,
    source: "runtime",
    target: completedTarget,
    traceContext: input.traceContext,
  });
  return { target: completedTarget, verification };
}

async function rejectStrictCompletion(
  runtime: AgentRuntimeInternal,
  target: SessionGoal,
  traceContext: TraceContext,
  reason: string,
): Promise<TargetCompletionVerificationResult> {
  const verification = failedGoalCompletionVerification(reason);
  const projection = await runtime.rebuildProjection();
  const latest = projection.targetCompletionVerificationTimeline
    .filter((item) => item.targetId === target.targetID)
    .at(-1);
  if (latest)
    await runtime.appendEvent(
      runtime.createEvent(
        SessionEventType.TargetCompletionVerification,
        {
          targetId: target.targetID,
          verificationId: latest.verificationId,
          goalIteration: latest.goalIteration,
          status: "failed_closed",
          verification,
        },
        traceContext,
      ),
      traceContext,
    );
  return { target, verification };
}
