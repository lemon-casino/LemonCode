import type { DatabaseSync } from "node:sqlite";
import type { SessionId, SessionGoal, GoalStatus } from "@lcode/contracts";
import { mustReadTarget, touchSessionForTarget } from "./session-target-record.js";

/** Clone the durable goal policy and accounting; active run authority stays with its session. */
export function cloneSessionTargetForFork(
  db: DatabaseSync,
  input: {
    source: SessionGoal;
    sessionID: SessionId;
    status: GoalStatus;
  },
): SessionGoal {
  const now = Date.now();
  const source = input.source;
  // fork 是 session state branch，不是新建 goal。必须保留 target_id 和
  // 原始 created time，让已复制的 goal-continuation / verifier metadata 能继续对齐。
  // active run 字段属于父 session 当前运行态，child 不能继承，否则会显示幽灵运行中。
  db.prepare(
    `
    insert into session_target (
      session_id,
      target_id,
      objective,
      summary_title,
      status,
      token_budget,
      tokens_used,
      time_used_seconds,
      active_input_id,
      active_run_started_at,
      active_run_last_seen_at,
      time_created,
      time_updated
      , acceptance_json
    ) values (?, ?, ?, ?, ?, ?, ?, ?, null, null, null, ?, ?, ?)
    on conflict(session_id) do update set
      target_id = excluded.target_id,
      objective = excluded.objective,
      summary_title = excluded.summary_title,
      status = excluded.status,
      token_budget = excluded.token_budget,
      tokens_used = excluded.tokens_used,
      time_used_seconds = excluded.time_used_seconds,
      active_input_id = null,
      active_run_started_at = null,
      active_run_last_seen_at = null,
      time_created = excluded.time_created,
      time_updated = excluded.time_updated
      , acceptance_json = excluded.acceptance_json
    `,
  ).run(
    input.sessionID,
    source.targetID,
    source.objective,
    source.summaryTitle,
    input.status,
    source.tokenBudget,
    source.tokensUsed,
    source.timeUsedSeconds,
    source.time.created,
    source.time.updated,
    source.acceptance ? JSON.stringify(source.acceptance) : null,
  );
  touchSessionForTarget(db, input.sessionID, now);
  return mustReadTarget(db, input.sessionID);
}
