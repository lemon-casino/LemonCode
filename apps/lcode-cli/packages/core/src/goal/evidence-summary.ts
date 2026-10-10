import {
  goalAcceptanceHash,
  goalEvidenceHeadId,
  goalEvidenceHeadSchema,
  goalEvidenceSchema,
  GOAL_EVIDENCE_HEAD_LIMIT,
  GOAL_EVIDENCE_RECEIPT_LIMIT,
  SESSION_ENTRY_GOAL_EVIDENCE,
  SESSION_ENTRY_GOAL_EVIDENCE_HEAD,
  type GoalEvidenceHeadToken,
  type GoalEvidenceSummary,
  type SessionGoal,
} from "@lcode/contracts";
import { bindingHash, digestGoalFiles } from "./evidence-files.js";
import type { GoalEvidenceOwner } from "./evidence-types.js";

export interface GoalEvidenceSnapshot {
  summary: GoalEvidenceSummary;
  evidenceHeads: GoalEvidenceHeadToken[];
}

/** The public projection intentionally omits the storage CAS tokens. */
export async function readGoalEvidenceSummary(
  owner: GoalEvidenceOwner,
  goal: SessionGoal,
): Promise<GoalEvidenceSummary | undefined> {
  return (await readGoalEvidenceSnapshot(owner, goal))?.summary;
}

export async function readGoalEvidenceSnapshot(
  owner: GoalEvidenceOwner,
  goal: SessionGoal,
): Promise<GoalEvidenceSnapshot | undefined> {
  if (!goal.acceptance) return undefined;
  const contractHash = goalAcceptanceHash(goal.acceptance);
  const [binding, receipts, heads] = await Promise.all([
    bindingHash(owner),
    owner.store?.sessionEntries?.({ sessionID: owner.sessionId, type: SESSION_ENTRY_GOAL_EVIDENCE, limit: GOAL_EVIDENCE_RECEIPT_LIMIT + 1 }) ?? [],
    owner.store?.sessionEntries?.({ sessionID: owner.sessionId, type: SESSION_ENTRY_GOAL_EVIDENCE_HEAD, limit: GOAL_EVIDENCE_HEAD_LIMIT + 1 }) ?? [],
  ]);
  const overflow = receipts.length > GOAL_EVIDENCE_RECEIPT_LIMIT || heads.length > GOAL_EVIDENCE_HEAD_LIMIT;
  const requirements: GoalEvidenceSummary["requirements"] = [];
  const evidenceHeads: GoalEvidenceHeadToken[] = [];
  for (const requirement of goal.acceptance.requirements) {
    const headId = goalEvidenceHeadId({ sessionId: owner.sessionId, goalId: goal.targetID, requirementId: requirement.id, contractHash });
    const candidates = heads.filter((entry) => entry.type === SESSION_ENTRY_GOAL_EVIDENCE_HEAD && entry.id === headId);
    const parsedHead = goalEvidenceHeadSchema.safeParse(candidates[0]?.data);
    if (candidates.length !== 1 || !parsedHead.success) {
      // 旧 receipt 没有 durable start，不具备“当前执行”的证明；冷恢复也不能回退旧 PASS。
      requirements.push({ requirementId: requirement.id, status: candidates.length ? "unknown" : "not-run" });
      continue;
    }
    const head = parsedHead.data;
    if (head.headId !== headId || head.sessionId !== owner.sessionId || head.goalId !== goal.targetID || head.requirementId !== requirement.id || head.contractHash !== contractHash || head.workspaceKey !== owner.workspaceKey || head.workspacePath !== owner.workspacePath) {
      requirements.push({ requirementId: requirement.id, status: "unknown" });
      continue;
    }
    evidenceHeads.push({ requirementId: head.requirementId, headId, attemptId: head.attemptId, executionId: head.executionId, receiptId: head.receiptId });
    const matching = receipts.filter((entry) => entry.type === SESSION_ENTRY_GOAL_EVIDENCE && entry.id === head.receiptId);
    const parsed = goalEvidenceSchema.safeParse(matching[0]?.data);
    if (matching.length !== 1 || !parsed.success) {
      requirements.push({ requirementId: requirement.id, status: "unknown" });
      continue;
    }
    const item = parsed.data;
    if (item.evidenceId !== head.receiptId || item.sessionId !== head.sessionId || item.goalId !== head.goalId || item.requirementId !== head.requirementId || item.contractHash !== head.contractHash || item.executionId !== head.executionId || item.bindingHash !== head.bindingHash || item.workspaceKey !== head.workspaceKey || item.workspacePath !== head.workspacePath || item.startedAt !== head.startedAt || item.source !== requirement.source) {
      requirements.push({ requirementId: requirement.id, status: "unknown" });
      continue;
    }
    let status = item.status;
    if (binding === null) status = "unknown";
    else if (head.bindingHash !== binding) status = "stale";
    if (status === "passed" || status === "failed") {
      const input = await digestGoalFiles(owner, requirement.inputPaths);
      const artifacts = await digestGoalFiles(owner, requirement.artifactPaths);
      status = input === null || artifacts === null ? "unknown" : input !== item.inputDigest || artifacts !== item.artifactDigest ? "stale" : status;
    }
    if (overflow) status = "unknown";
    requirements.push({ requirementId: requirement.id, status, evidenceId: item.evidenceId });
  }
  return {
    summary: {
      policy: "strict", contractHash,
      outcome: requirements.every((item) => item.status === "passed") ? "pass" : requirements.every((item) => item.status === "passed" || item.status === "failed") ? "notSatisfied" : "incomplete",
      requirements,
    },
    evidenceHeads,
  };
}
