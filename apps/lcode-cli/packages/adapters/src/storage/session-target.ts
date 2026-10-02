// ============================================================
// SQLite session target helpers
// ============================================================

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { SessionId, SessionGoal, GoalStatus } from "@lcode/contracts";
import {
  readSessionTarget,
  mustReadTarget,
  touchSessionForTarget,
} from "./session-target-record.js";

export { readSessionTarget } from "./session-target-record.js";

export function setSessionTarget(
  db: DatabaseSync,
  input: {
    objective: string;
    sessionID: SessionId;
    status: GoalStatus;
    tokenBudget?: number | null;
  },
): SessionGoal {
  const now = Date.now();
  const targetID = createStorageTargetId();
  db.prepare(
    `
    insert into session_target (
      session_id, target_id, objective, summary_title, status, token_budget, tokens_used, time_used_seconds, time_created, time_updated
    ) values (?, ?, ?, null, ?, ?, 0, 0, ?, ?)
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
    `,
  ).run(
    input.sessionID,
    targetID,
    input.objective,
    input.status,
    input.tokenBudget ?? null,
    now,
    now,
  );
  touchSessionForTarget(db, input.sessionID, now);
  return mustReadTarget(db, input.sessionID);
}

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
    ) values (?, ?, ?, ?, ?, ?, ?, ?, null, null, null, ?, ?)
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
  );
  touchSessionForTarget(db, input.sessionID, now);
  return mustReadTarget(db, input.sessionID);
}

export function createSessionTarget(
  db: DatabaseSync,
  input: { objective: string; sessionID: SessionId; tokenBudget?: number | null },
): SessionGoal | null {
  const now = Date.now();
  const targetID = createStorageTargetId();
  db.prepare(
    `
    insert or ignore into session_target (
      session_id, target_id, objective, summary_title, status, token_budget, tokens_used, time_used_seconds, time_created, time_updated
    ) values (?, ?, ?, null, 'active', ?, 0, 0, ?, ?)
    `,
  ).run(input.sessionID, targetID, input.objective, input.tokenBudget ?? null, now, now);

  const target = readSessionTarget(db, { sessionID: input.sessionID });
  if (target?.targetID !== targetID) return null;
  touchSessionForTarget(db, input.sessionID, now);
  return target;
}

export function updateSessionTargetStatus(
  db: DatabaseSync,
  input: { sessionID: SessionId; status: GoalStatus },
): SessionGoal | null {
  const now = Date.now();
  const result = db
    .prepare(
      `
      update session_target
      set status = ?, time_updated = ?
      where session_id = ?
      `,
    )
    .run(input.status, now, input.sessionID);
  if (result.changes === 0) return null;
  touchSessionForTarget(db, input.sessionID, now);
  return mustReadTarget(db, input.sessionID);
}

export function startSessionTargetRun(
  db: DatabaseSync,
  input: {
    sessionID: SessionId;
    targetID: string;
    inputID: string;
    startedAtMs: number;
  },
): SessionGoal | null {
  const startedAt = Math.max(0, input.startedAtMs);
  // goal live 计时必须跟随 agent 运行边界落库，不能再由 UI 从 assistant
  // message timestamp 反推；恢复 snapshot 时该 timestamp 可能是旧轮次，导致切回后异常增长。
  const result = db
    .prepare(
      `
      update session_target
      set
        active_input_id = ?,
        active_run_started_at = ?,
        active_run_last_seen_at = ?,
        time_updated = max(time_updated, ?)
      where session_id = ?
        and target_id = ?
        and status = 'active'
      `,
    )
    .run(input.inputID, startedAt, startedAt, startedAt, input.sessionID, input.targetID);
  if (result.changes === 0) return readSessionTarget(db, { sessionID: input.sessionID });
  touchSessionForTarget(db, input.sessionID, startedAt);
  return mustReadTarget(db, input.sessionID);
}

export function heartbeatSessionTargetRun(
  db: DatabaseSync,
  input: {
    sessionID: SessionId;
    targetID: string;
    inputID: string;
    seenAtMs: number;
  },
): SessionGoal | null {
  const seenAt = Math.max(0, input.seenAtMs);
  const result = db
    .prepare(
      `
      update session_target
      set
        active_run_last_seen_at = max(coalesce(active_run_last_seen_at, 0), ?),
        time_updated = max(time_updated, ?)
      where session_id = ?
        and target_id = ?
        and active_input_id = ?
        and active_run_started_at is not null
      `,
    )
    .run(seenAt, seenAt, input.sessionID, input.targetID, input.inputID);
  if (result.changes === 0) return readSessionTarget(db, { sessionID: input.sessionID });
  touchSessionForTarget(db, input.sessionID, seenAt);
  return mustReadTarget(db, input.sessionID);
}

export function finishSessionTargetRun(
  db: DatabaseSync,
  input: {
    sessionID: SessionId;
    targetID: string;
    inputID: string;
    endedAtMs: number;
    status?: GoalStatus;
    tokensUsedDelta?: number;
  },
): SessionGoal | null {
  const current = readSessionTarget(db, { sessionID: input.sessionID });
  if (
    !current ||
    current.targetID !== input.targetID ||
    current.activeInputId !== input.inputID ||
    current.activeRunStartedAtMs == null
  ) {
    return current;
  }

  const endedAt = Math.max(0, input.endedAtMs);
  const tokenDelta = Math.max(0, input.tokensUsedDelta ?? 0);
  const timeDelta = elapsedSecondsBetween(current.activeRunStartedAtMs, endedAt);
  const result = db
    .prepare(
      `
      update session_target
      set
        tokens_used = tokens_used + ?,
        time_used_seconds = time_used_seconds + ?,
        status = case
          when ? is not null then ?
          when status = 'active' and token_budget is not null and tokens_used + ? >= token_budget then 'budget_limited'
          else status
        end,
        active_input_id = null,
        active_run_started_at = null,
        active_run_last_seen_at = null,
        time_updated = max(time_updated, ?)
      where session_id = ?
        and target_id = ?
        and active_input_id = ?
        and active_run_started_at = ?
      `,
    )
    .run(
      tokenDelta,
      timeDelta,
      input.status ?? null,
      input.status ?? null,
      tokenDelta,
      endedAt,
      input.sessionID,
      input.targetID,
      input.inputID,
      current.activeRunStartedAtMs,
    );
  if (result.changes === 0) return readSessionTarget(db, { sessionID: input.sessionID });
  touchSessionForTarget(db, input.sessionID, endedAt);
  return mustReadTarget(db, input.sessionID);
}

export function recoverInterruptedSessionTargetRun(
  db: DatabaseSync,
  input: { sessionID: SessionId },
): SessionGoal | null {
  const current = readSessionTarget(db, { sessionID: input.sessionID });
  if (!current || !current.activeInputId || current.activeRunStartedAtMs == null) {
    return current;
  }

  // 进程崩溃/退出后，active_run_started_at 只能说明上次没有正常收口。
  // 恢复时不能用 Date.now() 结算，否则 app 离线时间会被计入 goal 运行时长。
  const endedAt = current.activeRunLastSeenAtMs ?? current.activeRunStartedAtMs;
  const timeDelta = elapsedSecondsBetween(current.activeRunStartedAtMs, endedAt);
  const nextStatus: GoalStatus = current.status === "active" ? "paused" : current.status;
  const result = db
    .prepare(
      `
      update session_target
      set
        time_used_seconds = time_used_seconds + ?,
        status = ?,
        active_input_id = null,
        active_run_started_at = null,
        active_run_last_seen_at = null,
        time_updated = max(time_updated, ?)
      where session_id = ?
        and target_id = ?
        and active_input_id = ?
        and active_run_started_at = ?
      `,
    )
    .run(
      timeDelta,
      nextStatus,
      endedAt,
      input.sessionID,
      current.targetID,
      current.activeInputId,
      current.activeRunStartedAtMs,
    );
  if (result.changes === 0) return readSessionTarget(db, { sessionID: input.sessionID });
  touchSessionForTarget(db, input.sessionID, endedAt);
  return mustReadTarget(db, input.sessionID);
}

export function accountSessionTargetUsage(
  db: DatabaseSync,
  input: {
    sessionID: SessionId;
    targetID: string;
    tokensUsedDelta?: number;
    timeUsedSecondsDelta?: number;
  },
): SessionGoal | null {
  const now = Date.now();
  const tokenDelta = Math.max(0, input.tokensUsedDelta ?? 0);
  const timeDelta = Math.max(0, input.timeUsedSecondsDelta ?? 0);
  if (tokenDelta === 0 && timeDelta === 0) {
    return readSessionTarget(db, { sessionID: input.sessionID });
  }

  const result = db
    .prepare(
      `
      update session_target
      set
        tokens_used = tokens_used + ?,
        time_used_seconds = time_used_seconds + ?,
        status = case
          when status = 'active' and token_budget is not null and tokens_used + ? >= token_budget then 'budget_limited'
          else status
        end,
        time_updated = ?
      where session_id = ? and target_id = ?
      `,
    )
    .run(tokenDelta, timeDelta, tokenDelta, now, input.sessionID, input.targetID);
  if (result.changes === 0) return readSessionTarget(db, { sessionID: input.sessionID });
  touchSessionForTarget(db, input.sessionID, now);
  return mustReadTarget(db, input.sessionID);
}

export function updateSessionTargetSummaryTitle(
  db: DatabaseSync,
  input: {
    sessionID: SessionId;
    targetID: string;
    summaryTitle: string;
  },
): SessionGoal | null {
  const now = Date.now();
  // goal 概要由异步 title sidecar 生成；用户可能在模型返回前 replace/clear goal。
  // 必须带 target_id 条件写回，避免旧 objective 的概要覆盖新目标。
  const result = db
    .prepare(
      `
      update session_target
      set summary_title = ?, time_updated = ?
      where session_id = ? and target_id = ?
      `,
    )
    .run(input.summaryTitle, now, input.sessionID, input.targetID);
  if (result.changes === 0) return readSessionTarget(db, { sessionID: input.sessionID });
  touchSessionForTarget(db, input.sessionID, now);
  return mustReadTarget(db, input.sessionID);
}

export function clearSessionTarget(db: DatabaseSync, input: { sessionID: SessionId }): boolean {
  const now = Date.now();
  const result = db.prepare("delete from session_target where session_id = ?").run(input.sessionID);
  if (result.changes === 0) return false;
  touchSessionForTarget(db, input.sessionID, now);
  return true;
}

function createStorageTargetId(): string {
  return `target_${Date.now().toString(36)}_${randomUUID()}`;
}

function elapsedSecondsBetween(startedAtMs: number, endedAtMs: number): number {
  return Math.max(0, Math.ceil((endedAtMs - startedAtMs) / 1000));
}
