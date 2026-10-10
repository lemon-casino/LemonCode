import type { DatabaseSync } from "node:sqlite";
import {
  goalAcceptanceHash,
  type SessionId,
  type SessionGoal,
  type GoalStatus,
  type GoalEvidenceHeadToken,
} from "@lcode/contracts";
import { goalEvidenceCompletionPredicate } from "./session-store/store-goal-evidence.js";
import {
  readSessionTarget,
  mustReadTarget,
  touchSessionForTarget,
} from "./session-target-record.js";

export function updateSessionTargetStatus(
  db: DatabaseSync,
  input: {
    sessionID: SessionId;
    status: GoalStatus;
    expected?: {
      targetID: string;
      updatedAt: number;
      stateRevision?: number;
      acceptanceHash?: string;
      evidenceHeads?: GoalEvidenceHeadToken[];
    };
  },
): SessionGoal | null {
  const now = Date.now();
  const current = readSessionTarget(db, input);
  if (
    input.status === "complete" &&
    current?.acceptance &&
    (!input.expected ||
      input.expected.stateRevision === undefined ||
      !input.expected.acceptanceHash)
  ) {
    throw new Error("Strict completion requires the current goal, acceptance and state revision.");
  }
  // 严格验收是异步的；必须在同一 SQLite 写入前核对目标与验收版本，避免旧裁判完成替换后的 Goal。
  if (input.expected) {
    if (
      !current ||
      current.status !== "active" ||
      current.targetID !== input.expected.targetID ||
      (input.expected.stateRevision === undefined &&
        current.time.updated !== input.expected.updatedAt) ||
      (input.expected.stateRevision !== undefined &&
        current.stateRevision !== input.expected.stateRevision) ||
      (input.expected.acceptanceHash !== undefined &&
        (!current.acceptance ||
          goalAcceptanceHash(current.acceptance) !== input.expected.acceptanceHash))
    )
      return null;
  }
  const predicate = ["session_id = ?"];
  const expectedValues: (string | number)[] = [];
  if (input.status === "complete" && current?.acceptance) {
    const tokens = input.expected?.evidenceHeads;
    const ids = new Set(tokens?.map((token) => token.requirementId));
    if (!tokens || tokens.length !== current.acceptance.requirements.length || ids.size !== tokens.length || current.acceptance.requirements.some((r) => !ids.has(r.id))) throw new Error("Strict completion requires complete durable evidence head coverage.");
    const evidence = goalEvidenceCompletionPredicate(db, input.sessionID, current, tokens);
    if (!evidence) return null;
    predicate.push(...evidence.predicates); expectedValues.push(...evidence.values);
  }
  if (input.expected) {
    predicate.push("target_id = ?", "status = 'active'");
    expectedValues.push(input.expected.targetID);
    if (input.expected.stateRevision !== undefined) {
      predicate.push("state_revision = ?");
      expectedValues.push(input.expected.stateRevision);
    } else {
      predicate.push("time_updated = ?");
      expectedValues.push(input.expected.updatedAt);
    }
    if (input.expected.acceptanceHash !== undefined) {
      predicate.push("acceptance_json = ?");
      expectedValues.push(JSON.stringify(current!.acceptance));
    }
  }
  // JS 预读后其他 SQLite 连接仍可写入；版本条件必须由 UPDATE 本身原子裁决。
  const result = db
    .prepare(
      `
      update session_target
      set status = ?, time_updated = ?, state_revision = state_revision + 1
      where ${predicate.join(" and ")}
      `,
    )
    .run(input.status, now, input.sessionID, ...expectedValues);
  if (result.changes === 0) return null;
  touchSessionForTarget(db, input.sessionID, now);
  return mustReadTarget(db, input.sessionID);
}
