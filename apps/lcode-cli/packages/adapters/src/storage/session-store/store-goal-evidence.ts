import type { DatabaseSync } from "node:sqlite";
import {
  GOAL_EVIDENCE_RECEIPT_LIMIT, GOAL_EVIDENCE_HEAD_LIMIT, GOAL_EVIDENCE_ATTEMPT_LIMIT,
  SESSION_ENTRY_GOAL_EVIDENCE, SESSION_ENTRY_GOAL_EVIDENCE_ATTEMPT, SESSION_ENTRY_GOAL_EVIDENCE_HEAD,
  goalEvidenceAttemptSchema, goalEvidenceHeadSchema, goalEvidenceSchema,
  goalEvidenceHeadId, goalEvidenceAttemptId, goalEvidenceEntryId, goalAcceptanceHash, goalRequirementMatches,
  type BeginGoalEvidenceExecutionInput, type BeginGoalEvidenceExecutionResult, type GoalEvidenceHeadToken,
  type SessionEntryInfo, type SessionGoal, type SessionId,
} from "@lcode/contracts";
import { readSessionTarget } from "../session-target-record.js";
import * as entries from "./repositories/session-entries.js";

interface EntryRow { session_id: string; type: string; data: string }
function row(db: DatabaseSync, id: string): EntryRow | undefined {
  return db.prepare("select session_id, type, data from session_entry where id = ?").get(id) as EntryRow | undefined;
}

/** 同一事务先写不可变 admission 再更新全部 head；失败时执行端还没有产生副作用。 */
export function beginGoalEvidenceExecution(db: DatabaseSync, input: BeginGoalEvidenceExecutionInput): BeginGoalEvidenceExecutionResult {
  const attempt = goalEvidenceAttemptSchema.parse(input.attempt);
  if (attempt.sessionId !== input.sessionID || attempt.goalId !== input.expected.targetID || attempt.contractHash !== input.expected.acceptanceHash || attempt.attemptId !== goalEvidenceAttemptId(attempt)) throw new Error("Invalid goal evidence admission identity");
  db.exec("begin immediate");
  try {
    const goal = readSessionTarget(db, input);
    if (!goal?.acceptance || goal.status !== "active" || goal.targetID !== input.expected.targetID || (goal.stateRevision ?? 0) !== input.expected.stateRevision || goalAcceptanceHash(goal.acceptance) !== input.expected.acceptanceHash) {
      db.exec("rollback"); return { kind: "stale" };
    }
    const matched = goal.acceptance.requirements.filter((r) => goalRequirementMatches(r, attempt));
    if (matched.length !== attempt.heads.length || new Set(attempt.heads.map((h) => h.requirementId)).size !== matched.length || matched.some((r) => !attempt.heads.some((h) => h.requirementId === r.id))) throw new Error("Goal evidence admission must cover every matching requirement");
    for (const head of attempt.heads) {
      for (const key of ["sessionId", "goalId", "contractHash", "workspaceKey", "workspacePath", "bindingHash", "executionId", "startedAt", "attemptId"] as const) if (head[key] !== attempt[key]) throw new Error("Goal evidence head differs from its attempt");
      if (head.headId !== goalEvidenceHeadId(head) || head.receiptId !== goalEvidenceEntryId(head)) throw new Error("Invalid goal evidence head identity");
    }
    const prior = row(db, attempt.attemptId);
    if (prior) {
      if (prior.session_id !== input.sessionID || prior.type !== SESSION_ENTRY_GOAL_EVIDENCE_ATTEMPT) throw new Error("Goal evidence admission identity collision");
      const original = goalEvidenceAttemptSchema.parse(JSON.parse(prior.data));
      if (JSON.stringify(original) !== JSON.stringify(attempt)) throw new Error("Goal evidence admission is immutable");
      db.exec("commit"); return { kind: "duplicate", attempt: original };
    }
    const attempts = entries.sessionEntries(db, { sessionID: input.sessionID, type: SESSION_ENTRY_GOAL_EVIDENCE_ATTEMPT, limit: 513 });
    const heads = entries.sessionEntries(db, { sessionID: input.sessionID, type: SESSION_ENTRY_GOAL_EVIDENCE_HEAD, limit: 513 });
    const receipts = entries.sessionEntries(db, { sessionID: input.sessionID, type: SESSION_ENTRY_GOAL_EVIDENCE, limit: 513 });
    const reserved = new Set(receipts.map((entry) => entry.id));
    for (const entry of attempts) for (const head of goalEvidenceAttemptSchema.parse(entry.data).heads) reserved.add(head.receiptId);
    const newHeads = attempt.heads.filter((head) => !heads.some((entry) => entry.id === head.headId));
    if (attempts.length >= GOAL_EVIDENCE_ATTEMPT_LIMIT || heads.length + newHeads.length > GOAL_EVIDENCE_HEAD_LIMIT || new Set([...reserved, ...attempt.heads.map((head) => head.receiptId)]).size > GOAL_EVIDENCE_RECEIPT_LIMIT) {
      db.exec("rollback"); return { kind: "full" };
    }
    for (const head of attempt.heads) {
      const existing = row(db, head.headId);
      if (existing && (existing.session_id !== input.sessionID || existing.type !== SESSION_ENTRY_GOAL_EVIDENCE_HEAD)) throw new Error("Goal evidence head identity collision");
    }
    entries.saveSessionEntry(db, { id: attempt.attemptId, sessionID: input.sessionID, type: SESSION_ENTRY_GOAL_EVIDENCE_ATTEMPT, time: { created: attempt.startedAt, updated: attempt.startedAt }, touchSession: false, data: attempt });
    for (const head of attempt.heads) entries.saveSessionEntry(db, { id: head.headId, sessionID: input.sessionID, type: SESSION_ENTRY_GOAL_EVIDENCE_HEAD, time: { created: head.startedAt, updated: head.startedAt }, touchSession: false, data: head });
    db.exec("commit"); return { kind: "admitted", attempt };
  } catch (error) { db.exec("rollback"); throw error; }
}

/** generic entry upsert 不能覆盖同一实际执行的首份 terminal receipt。 */
export function saveImmutableGoalEvidenceReceipt(db: DatabaseSync, input: SessionEntryInfo): void {
  const evidence = goalEvidenceSchema.parse(input.data);
  if (input.id !== evidence.evidenceId || input.sessionID !== evidence.sessionId || evidence.evidenceId !== goalEvidenceEntryId(evidence)) throw new Error("Invalid immutable goal evidence identity");
  const encoded = JSON.stringify(evidence);
  const result = db.prepare("insert or ignore into session_entry(id,session_id,type,time_created,time_updated,data) values(?,?,?,?,?,?)").run(input.id, input.sessionID, SESSION_ENTRY_GOAL_EVIDENCE, evidence.startedAt, evidence.completedAt, encoded);
  if (result.changes !== 0) return;
  const existing = row(db, input.id);
  if (!existing || existing.session_id !== input.sessionID || existing.type !== SESSION_ENTRY_GOAL_EVIDENCE) throw new Error("Goal evidence receipt is immutable");
  const previous = goalEvidenceSchema.parse(JSON.parse(existing.data));
  const { startedAt: _previousStart, completedAt: _previousEnd, ...original } = previous;
  const { startedAt: _nextStart, completedAt: _nextEnd, ...next } = evidence;
  if (JSON.stringify(original) !== JSON.stringify(next)) throw new Error("Goal evidence receipt is immutable");
}

/** Prevalidate receipt shapes, then freeze their exact bytes in the final SQL predicate. */
export function goalEvidenceCompletionPredicate(db: DatabaseSync, sessionID: SessionId, goal: SessionGoal, tokens: GoalEvidenceHeadToken[]): { predicates: string[]; values: string[] } | null {
  const predicates: string[] = [], values: string[] = [];
  const hash = goalAcceptanceHash(goal.acceptance!);
  for (const token of tokens) {
    const storedHead = row(db, token.headId), storedReceipt = row(db, token.receiptId), storedAttempt = row(db, token.attemptId);
    if (!storedHead || storedHead.session_id !== sessionID || storedHead.type !== SESSION_ENTRY_GOAL_EVIDENCE_HEAD || !storedReceipt || storedReceipt.session_id !== sessionID || storedReceipt.type !== SESSION_ENTRY_GOAL_EVIDENCE || !storedAttempt || storedAttempt.session_id !== sessionID || storedAttempt.type !== SESSION_ENTRY_GOAL_EVIDENCE_ATTEMPT) return null;
    const h = goalEvidenceHeadSchema.safeParse(parseRecord(storedHead.data)), r = goalEvidenceSchema.safeParse(parseRecord(storedReceipt.data)), a = goalEvidenceAttemptSchema.safeParse(parseRecord(storedAttempt.data));
    if (!h.success || !r.success || !a.success) return null;
    const head = h.data, receipt = r.data;
    if (a.data.attemptId !== goalEvidenceAttemptId(a.data) || !a.data.heads.some((value) => JSON.stringify(value) === JSON.stringify(head)) || receipt.source !== a.data.source) return null;
    if (head.sessionId !== sessionID || head.goalId !== goal.targetID || head.contractHash !== hash || head.headId !== goalEvidenceHeadId(head) || head.receiptId !== goalEvidenceEntryId(head) || ["requirementId", "headId", "attemptId", "executionId", "receiptId"].some((key) => head[key as keyof GoalEvidenceHeadToken] !== token[key as keyof GoalEvidenceHeadToken])) return null;
    if (receipt.status !== "passed" || receipt.exitCode !== 0 || receipt.inputDigest === null || receipt.artifactDigest === null || receipt.evidenceId !== head.receiptId || ["sessionId", "goalId", "requirementId", "contractHash", "workspaceKey", "workspacePath", "bindingHash", "executionId", "startedAt"].some((key) => receipt[key as keyof typeof receipt] !== head[key as keyof typeof head])) return null;
    // 多连接可在 JS 读后开始新检查；UPDATE 必须同时比较 head 与已校验 receipt 的精确持久字节。
    predicates.push("exists (select 1 from session_entry gh join session_entry gr on gr.id = ? and gr.session_id = session_target.session_id and gr.type = ? and gr.data = ? join session_entry ga on ga.id = ? and ga.session_id = session_target.session_id and ga.type = ? and ga.data = ? where gh.id = ? and gh.session_id = session_target.session_id and gh.type = ? and gh.data = ?)");
    values.push(token.receiptId, SESSION_ENTRY_GOAL_EVIDENCE, storedReceipt.data, token.attemptId, SESSION_ENTRY_GOAL_EVIDENCE_ATTEMPT, storedAttempt.data, token.headId, SESSION_ENTRY_GOAL_EVIDENCE_HEAD, storedHead.data);
  }
  return { predicates, values };
}

function parseRecord(value: string): unknown {
  try { return JSON.parse(value); } catch { return null; }
}
