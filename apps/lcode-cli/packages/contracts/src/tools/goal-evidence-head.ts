import { createHash } from "node:crypto";
import { z } from "zod";
import type { SessionId } from "../interfaces/shared.js";

export const SESSION_ENTRY_GOAL_EVIDENCE_HEAD = "goal/evidence-head/v1";
export const SESSION_ENTRY_GOAL_EVIDENCE_ATTEMPT = "goal/evidence-attempt/v1";
export const GOAL_EVIDENCE_RECEIPT_LIMIT = 512;
export const GOAL_EVIDENCE_HEAD_LIMIT = 512;
export const GOAL_EVIDENCE_ATTEMPT_LIMIT = 512;
const id = z.string().min(1).max(512);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const goalEvidenceHeadSchema = z.object({
  schemaVersion: z.literal(1), headId: id, attemptId: id,
  sessionId: id, goalId: id, requirementId: z.string().min(1).max(128),
  contractHash: hash, workspaceKey: z.string().min(1), workspacePath: z.string().min(1),
  bindingHash: hash, executionId: id, receiptId: id, startedAt: z.number().int().nonnegative(),
}).strict();
export type GoalEvidenceHead = z.infer<typeof goalEvidenceHeadSchema>;
export const goalEvidenceAttemptSchema = z.object({
  schemaVersion: z.literal(1), attemptId: id, sessionId: id, goalId: id,
  contractHash: hash, workspaceKey: z.string().min(1), workspacePath: z.string().min(1),
  bindingHash: hash, executionId: id, source: z.enum(["Bash", "world.run"]),
  command: z.string().min(1).max(8192), args: z.array(z.string().max(8192)).max(128).optional(),
  startedAt: z.number().int().nonnegative(), heads: z.array(goalEvidenceHeadSchema).min(1).max(16),
}).strict();
export type GoalEvidenceAttempt = z.infer<typeof goalEvidenceAttemptSchema>;
export interface GoalEvidenceHeadToken {
  requirementId: string; headId: string; attemptId: string; executionId: string; receiptId: string;
}
export interface BeginGoalEvidenceExecutionInput {
  sessionID: SessionId;
  expected: { targetID: string; stateRevision: number; acceptanceHash: string };
  attempt: GoalEvidenceAttempt;
}
export type BeginGoalEvidenceExecutionResult =
  | { kind: "admitted" | "duplicate"; attempt: GoalEvidenceAttempt }
  | { kind: "stale" | "full" };
export function goalEvidenceHeadId(input: Pick<GoalEvidenceHead, "sessionId" | "goalId" | "requirementId" | "contractHash">): string {
  return `goal_head_${digest([input.sessionId, input.goalId, input.requirementId, input.contractHash])}`;
}
export function goalEvidenceAttemptId(input: Pick<GoalEvidenceAttempt, "sessionId" | "goalId" | "executionId" | "contractHash">): string {
  return `goal_attempt_${digest([input.sessionId, input.goalId, input.executionId, input.contractHash])}`;
}
function digest(parts: string[]): string { return createHash("sha256").update(JSON.stringify(parts)).digest("hex"); }
