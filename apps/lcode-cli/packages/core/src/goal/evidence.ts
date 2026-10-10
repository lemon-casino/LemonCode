import {
  goalAcceptanceHash, goalEvidenceEntryId, goalEvidenceSchema, goalRequirementMatches,
  goalEvidenceAttemptId, goalEvidenceHeadId, goalEvidenceAttemptSchema,
  SESSION_ENTRY_GOAL_EVIDENCE, type GoalEvidence, type SessionGoal,
} from "@lcode/contracts";
import { bindingHash, digestGoalFiles } from "./evidence-files.js";
import type { GoalEvidenceOwner, GoalExecution, GoalExecutionCapture } from "./evidence-types.js";
export type { GoalEvidenceOwner, GoalExecution, GoalExecutionCapture } from "./evidence-types.js";
export { digestGoalFiles } from "./evidence-files.js";
export { readGoalEvidenceSummary, readGoalEvidenceSnapshot } from "./evidence-summary.js";

export class GoalEvidenceAdmissionError extends Error {
  override readonly name = "GoalEvidenceAdmissionError";
}

export async function beginGoalExecution(
  owner: GoalEvidenceOwner,
  execution: GoalExecution,
): Promise<GoalExecutionCapture | null> {
  let goal: SessionGoal | null | undefined;
  try {
    goal = await owner.store?.readTarget({ sessionID: owner.sessionId });
  } catch (error) {
    // 连策略读取都失败时无法证明不存在 strict，普通观察降级会放行一次无法结算的副作用。
    throw new GoalEvidenceAdmissionError("Execution goal policy could not be read.", { cause: error });
  }
  if (!goal?.acceptance || goal.status !== "active") return null;
  const matches = goal.acceptance.requirements.filter((requirement) =>
    goalRequirementMatches(requirement, execution),
  );
  if (!matches.length) return null;
  try {
  const binding = await bindingHash(owner);
  if (!binding) throw new GoalEvidenceAdmissionError("Strict execution binding is unknown.");
  const requirements = [];
  for (const requirement of matches)
    requirements.push({ requirement, before: await digestGoalFiles(owner, requirement.inputPaths) });
  const contractHash = goalAcceptanceHash(goal.acceptance);
  const attemptId = goalEvidenceAttemptId({ sessionId: owner.sessionId, goalId: goal.targetID, executionId: execution.executionId, contractHash });
  const attempt = goalEvidenceAttemptSchema.parse({
    schemaVersion: 1, attemptId, sessionId: owner.sessionId, goalId: goal.targetID, contractHash,
    workspaceKey: owner.workspaceKey, workspacePath: owner.workspacePath, bindingHash: binding,
    executionId: execution.executionId, source: execution.source, command: execution.command,
    ...(execution.args ? { args: [...execution.args] } : {}), startedAt: execution.startedAt,
    heads: matches.map((requirement) => ({
      schemaVersion: 1, headId: goalEvidenceHeadId({ sessionId: owner.sessionId, goalId: goal.targetID, requirementId: requirement.id, contractHash }),
      attemptId, sessionId: owner.sessionId, goalId: goal.targetID, requirementId: requirement.id, contractHash,
      workspaceKey: owner.workspaceKey, workspacePath: owner.workspacePath, bindingHash: binding,
      executionId: execution.executionId, startedAt: execution.startedAt,
      receiptId: goalEvidenceEntryId({ goalId: goal.targetID, executionId: execution.executionId, requirementId: requirement.id, contractHash }),
    })),
  });
  if (!owner.store?.beginGoalEvidenceExecution)
    throw new GoalEvidenceAdmissionError("Strict execution requires durable attempt admission.");
  let admission;
  try {
    admission = await owner.store.beginGoalEvidenceExecution({
      sessionID: owner.sessionId,
      expected: { targetID: goal.targetID, stateRevision: goal.stateRevision ?? 0, acceptanceHash: contractHash },
      attempt,
    });
  } catch (error) {
    // 若 start 写失败还执行，稍后一次可用的旧 PASS 会遮住这次执行；必须在实际副作用前中止。
    throw new GoalEvidenceAdmissionError("Strict execution start could not be persisted.", { cause: error });
  }
  if (admission.kind !== "admitted")
    throw new GoalEvidenceAdmissionError(`Strict execution admission rejected: ${admission.kind}.`);
  // 未知输入也留下 durable head，避免短暂文件故障恢复后借用旧证明；不启动无法核验的执行。
  if (requirements.some((item) => item.before === null) || (await bindingHash(owner)) !== binding)
    throw new GoalEvidenceAdmissionError("Strict execution inputs or binding are not verifiable.");
  return { owner, goal, execution, requirements, bindingHash: binding, attempt: admission.attempt };
  } catch (error) {
    if (error instanceof GoalEvidenceAdmissionError) throw error;
    throw new GoalEvidenceAdmissionError("Strict execution preparation failed.", { cause: error });
  }
}

export async function finishGoalExecution(
  capture: GoalExecutionCapture,
  facts: {
    exitCode: number | null;
    completedAt: number;
    cancelled?: boolean;
    output: GoalEvidence["output"];
  },
): Promise<GoalEvidence[]> {
  const { owner, goal, execution } = capture;
  if (!owner.store?.saveSessionEntry) return [];
  const existing =
    (await owner.store.sessionEntries?.({
      sessionID: owner.sessionId,
      type: SESSION_ENTRY_GOAL_EVIDENCE,
      limit: 513,
    })) ?? [];
  const current = await owner.store.readTarget({ sessionID: owner.sessionId });
  const contractHash = goalAcceptanceHash(goal.acceptance!);
  if ((await bindingHash(owner)) !== capture.bindingHash) return [];
  if (
    !current?.acceptance ||
    current.targetID !== goal.targetID ||
    current.status !== "active" ||
    (current.stateRevision ?? 0) !== (goal.stateRevision ?? 0) ||
    goalAcceptanceHash(current.acceptance) !== contractHash
  )
    return [];
  const results: GoalEvidence[] = [];
  for (const { requirement, before } of capture.requirements) {
    const after = await digestGoalFiles(owner, requirement.inputPaths);
    const artifactDigest = await digestGoalFiles(owner, requirement.artifactPaths);
    const latest = await owner.store.readTarget({ sessionID: owner.sessionId });
    // 哈希 IO 会让出执行权；读前的 active/revision 不能替代落证据前的再次核对。
    if (
      !latest?.acceptance ||
      latest.targetID !== goal.targetID ||
      latest.status !== "active" ||
      (latest.stateRevision ?? 0) !== (goal.stateRevision ?? 0) ||
      goalAcceptanceHash(latest.acceptance) !== contractHash ||
      (await bindingHash(owner)) !== capture.bindingHash
    )
      return [];
    const status: GoalEvidence["status"] = facts.cancelled
      ? "cancelled"
      : facts.exitCode === null || before === null || after === null || artifactDigest === null
        ? "unknown"
        : before !== after
          ? "stale"
          : facts.exitCode === 0
            ? "passed"
            : "failed";
    const evidence = goalEvidenceSchema.parse({
      schemaVersion: 1,
      evidenceId: goalEvidenceEntryId({
        goalId: goal.targetID,
        executionId: execution.executionId,
        requirementId: requirement.id,
        contractHash,
      }),
      sessionId: owner.sessionId,
      goalId: goal.targetID,
      requirementId: requirement.id,
      contractHash,
      workspaceKey: owner.workspaceKey,
      workspacePath: owner.workspacePath,
      executionId: execution.executionId,
      bindingHash: capture.bindingHash,
      source: execution.source,
      status,
      reasonCode: status,
      inputDigest: after,
      artifactDigest,
      exitCode: facts.exitCode,
      startedAt: execution.startedAt,
      completedAt: facts.completedAt,
      output: facts.output,
    });
    // 执行事实只写一次，重连/重复 terminal 不刷新历史时间，也不覆盖原有证据。
    const previous = existing.find((entry) => entry.id === evidence.evidenceId);
    if (previous) {
      const parsed = goalEvidenceSchema.safeParse(previous.data);
      if (parsed.success) results.push(parsed.data);
      continue;
    }
    if (existing.length + results.length >= 512) continue;
    await owner.store.saveSessionEntry({
      id: evidence.evidenceId,
      sessionID: owner.sessionId,
      type: SESSION_ENTRY_GOAL_EVIDENCE,
      touchSession: false,
      time: { created: evidence.startedAt, updated: evidence.completedAt },
      data: evidence,
    });
    results.push(evidence);
  }
  return results;
}

