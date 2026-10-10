import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  goalAcceptanceHash, goalAcceptanceSchema, goalEvidenceAttemptId, goalEvidenceHeadId, goalEvidenceEntryId,
  SESSION_ENTRY_GOAL_EVIDENCE, SESSION_ENTRY_GOAL_EVIDENCE_HEAD, SESSION_ENTRY_GOAL_EVIDENCE_ATTEMPT,
  type GoalEvidenceAttempt, type GoalEvidenceHead, type SessionGoal, type SessionId, type ProjectId,
} from "@lcode/contracts";
import { createSqliteSessionStore } from "../session-store.js";

const sessionID = "goal-head-session" as SessionId;
const hash = "a".repeat(64);
async function fixture(path = ":memory:", multiple = false) {
  const store = createSqliteSessionStore({ dbPath: path });
  await store.createSession({ id: sessionID, projectID: "project" as ProjectId, slug: "heads", directory: "fixture", title: "heads", version: "1" });
  const goal = await store.setTarget({ sessionID, objective: "task", acceptance: goalAcceptanceSchema.parse({
    policy: "strict", requirements: (multiple ? ["first", "second"] : ["first"]).map((id) => ({ id, description: id, source: "Bash", command: "node verify.mjs", inputPaths: ["source.ts"] })),
  }) });
  return { store, goal };
}
function attempt(goal: SessionGoal, executionId: string): GoalEvidenceAttempt {
  const base = { schemaVersion: 1 as const, sessionId: sessionID, goalId: goal.targetID, contractHash: goalAcceptanceHash(goal.acceptance!),
    executionId, workspaceKey: "fixture", workspacePath: "fixture", bindingHash: hash, startedAt: 10 };
  const attemptId = goalEvidenceAttemptId(base);
  return { ...base, attemptId, source: "Bash", command: "node verify.mjs", heads: goal.acceptance!.requirements.map((r) => {
    const data = { ...base, attemptId, requirementId: r.id };
    return { ...data, headId: goalEvidenceHeadId(data), receiptId: goalEvidenceEntryId(data) };
  }) };
}
function begin(h: Awaited<ReturnType<typeof fixture>>, a: GoalEvidenceAttempt) {
  return h.store.beginGoalEvidenceExecution!({ sessionID, expected: { targetID: h.goal.targetID, stateRevision: h.goal.stateRevision ?? 0, acceptanceHash: goalAcceptanceHash(h.goal.acceptance!) }, attempt: a });
}
function receipt(head: GoalEvidenceHead, status = "passed") {
  return { schemaVersion: 1, evidenceId: head.receiptId, sessionId: head.sessionId, goalId: head.goalId, requirementId: head.requirementId,
    contractHash: head.contractHash, workspaceKey: head.workspaceKey, workspacePath: head.workspacePath, bindingHash: head.bindingHash, executionId: head.executionId,
    source: "Bash", status, reasonCode: status, inputDigest: hash, artifactDigest: hash, exitCode: status === "passed" ? 0 : 1,
    startedAt: 10, completedAt: 20, output: { sha256: hash, bytes: 0, truncated: false, artifactRefs: [] } };
}
function save(h: Awaited<ReturnType<typeof fixture>>, head: GoalEvidenceHead, status = "passed") {
  return h.store.saveSessionEntry({ id: head.receiptId, sessionID, type: SESSION_ENTRY_GOAL_EVIDENCE, time: { created: 10, updated: 20 }, touchSession: false, data: receipt(head, status) });
}
function complete(h: Awaited<ReturnType<typeof fixture>>, heads: GoalEvidenceHead[]) {
  return h.store.updateTargetStatus({ sessionID, status: "complete", expected: {
    targetID: h.goal.targetID, updatedAt: h.goal.time.updated, stateRevision: h.goal.stateRevision,
    acceptanceHash: goalAcceptanceHash(h.goal.acceptance!), evidenceHeads: heads.map(({ requirementId, headId, attemptId, executionId, receiptId }) => ({ requirementId, headId, attemptId, executionId, receiptId })),
  } });
}

test("strict completion cannot accept missing head coverage and receipts are immutable", async () => {
  const h = await fixture();
  try {
    await assert.rejects(complete(h, []), /Strict completion/);
    const a = attempt(h.goal, "one");
    await save(h, a.heads[0]!);
    await save(h, a.heads[0]!);
    await assert.rejects(save(h, a.heads[0]!, "failed"), /immutable/);
    assert.equal((await h.store.sessionEntries({ sessionID, type: SESSION_ENTRY_GOAL_EVIDENCE })).length, 1);
  } finally { h.store.close(); }
});

test("begin commits every requirement and duplicate old admission never restores an old head", async () => {
  const h = await fixture(":memory:", true);
  try {
    const a = attempt(h.goal, "one"), b = attempt(h.goal, "two");
    assert.equal((await begin(h, a)).kind, "admitted");
    assert.equal((await begin(h, b)).kind, "admitted");
    assert.equal((await begin(h, a)).kind, "duplicate");
    const heads = await h.store.sessionEntries({ sessionID, type: SESSION_ENTRY_GOAL_EVIDENCE_HEAD });
    assert.equal(heads.length, 2);
    assert.ok(heads.every((entry) => (entry.data as GoalEvidenceHead).executionId === "two"));
    assert.equal((await h.store.readTarget({ sessionID }))?.stateRevision, h.goal.stateRevision);
    await Promise.all(b.heads.map((head) => save(h, head)));
    assert.equal(await complete(h, a.heads), null);
    assert.equal((await complete(h, b.heads))?.status, "complete");
  } finally { h.store.close(); }
});

test("partial begin write failure rolls back the attempt and every head before execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "lcode-head-atomic-"));
  const path = join(root, "session.db"), h = await fixture(path, true), db = new DatabaseSync(path);
  try {
    db.exec("create trigger reject_second_head before insert on session_entry when new.type = 'goal/evidence-head/v1' and json_extract(new.data, '$.requirementId') = 'second' begin select raise(abort, 'synthetic head failure'); end");
    await assert.rejects(begin(h, attempt(h.goal, "one")), /synthetic head failure/);
    assert.equal((await h.store.sessionEntries({ sessionID, type: SESSION_ENTRY_GOAL_EVIDENCE_HEAD })).length, 0);
    assert.equal((await h.store.sessionEntries({ sessionID, type: SESSION_ENTRY_GOAL_EVIDENCE_ATTEMPT })).length, 0);
  } finally { db.close(); h.store.close(); await rm(root, { recursive: true, force: true }); }
});

test("terminal write failure survives SQLite reopen and cannot commit a previous pass", async () => {
  const root = await mkdtemp(join(tmpdir(), "lcode-head-terminal-"));
  const path = join(root, "session.db"), h = await fixture(path), db = new DatabaseSync(path);
  try {
    const first = attempt(h.goal, "one"), second = attempt(h.goal, "two");
    await begin(h, first); await save(h, first.heads[0]!);
    await begin(h, second);
    db.exec("create trigger reject_receipt before insert on session_entry when new.type = 'goal/evidence/v1' and json_extract(new.data, '$.executionId') = 'two' begin select raise(abort, 'synthetic receipt failure'); end");
    await assert.rejects(save(h, second.heads[0]!, "failed"), /synthetic receipt failure/);
    assert.equal(await complete(h, first.heads), null);
    assert.equal(await complete(h, second.heads), null);
    h.store.close(); h.store = createSqliteSessionStore({ dbPath: path });
    assert.equal((await h.store.sessionEntries({ sessionID, type: SESSION_ENTRY_GOAL_EVIDENCE_HEAD }))[0]?.data && ((await h.store.sessionEntries({ sessionID, type: SESSION_ENTRY_GOAL_EVIDENCE_HEAD }))[0]!.data as GoalEvidenceHead).executionId, "two");
    assert.equal(await complete(h, first.heads), null);
    assert.equal(await complete(h, second.heads), null);
  } finally { db.close(); h.store.close(); await rm(root, { recursive: true, force: true }); }
});

test("stale admission rejects without heads and capacity reserves receipts before execution", async () => {
  const h = await fixture();
  try {
    const a = attempt(h.goal, "one");
    await h.store.updateTargetStatus({ sessionID, status: "paused" });
    assert.equal((await begin(h, a)).kind, "stale");
    assert.equal((await h.store.sessionEntries({ sessionID, type: SESSION_ENTRY_GOAL_EVIDENCE_HEAD })).length, 0);
    h.goal = (await h.store.updateTargetStatus({ sessionID, status: "active" }))!;
    for (let i = 0; i < 512; i++) await save(h, attempt(h.goal, `old-${i}`).heads[0]!);
    assert.equal((await begin(h, attempt(h.goal, "full"))).kind, "full");
    assert.equal((await h.store.sessionEntries({ sessionID, type: SESSION_ENTRY_GOAL_EVIDENCE_HEAD })).length, 0);
  } finally { h.store.close(); }
});
