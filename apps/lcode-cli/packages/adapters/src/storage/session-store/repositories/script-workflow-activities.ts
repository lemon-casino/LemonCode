import type { DatabaseSync } from "node:sqlite";
import type {
  CreateScriptWorkflowActivityInput,
  CreateSessionTaskLinkInput,
  ScriptWorkflowActivityRecord,
  ScriptWorkflowEventRecord,
  SessionId,
  SessionTaskLinkRecord,
  UpdateScriptWorkflowActivityInput,
} from "@lcode/contracts";
import { encodeJson } from "../json.js";
import {
  decodeActivity,
  decodeEvent,
  decodeTaskLink,
  type SessionTaskLinkRow,
  type WorkflowActivityRow,
  type WorkflowEventRow,
} from "./script-workflow-codecs.js";

export async function createScriptWorkflowActivity(
  db: DatabaseSync,
  input: CreateScriptWorkflowActivityInput,
): Promise<ScriptWorkflowActivityRecord> {
  const now = Date.now();
  const attemptRow = db
    .prepare(
      `
      select coalesce(max(attempt), 0) + 1 as next_attempt
      from workflow_activity where run_id = ? and call_path = ?
      `,
    )
    .get(input.runId, input.callPath) as { next_attempt: number } | undefined;
  const attempt = attemptRow?.next_attempt ?? 1;
  db
    .prepare(
      `
      insert into workflow_activity (
        id, run_id, parent_activity_id, call_index, call_path, attempt, type, phase,
        label, input_hash, prompt, opts_json, status, child_session_id, result_json,
        error_json, time_created, time_started, time_updated, time_completed
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, null, null, ?, null, ?, null)
      `,
    )
    .run(
      input.id,
      input.runId,
      input.parentActivityId ?? null,
      input.callIndex,
      input.callPath,
      attempt,
      input.type,
      input.phase ?? null,
      input.label ?? null,
      input.inputHash,
      input.prompt ?? null,
      encodeJson(input.opts),
      input.status ?? "queued",
      now,
      now,
    );
  return mustGetActivity(db, input.id);
}

export async function updateScriptWorkflowActivity(
  db: DatabaseSync,
  input: UpdateScriptWorkflowActivityInput,
): Promise<ScriptWorkflowActivityRecord> {
  const current = await getActivity(db, input.id);
  if (!current) throw new Error(`Workflow activity not found: ${input.id}`);
  const now = Date.now();
  db
    .prepare(
      `
      update workflow_activity set
        status = ?,
        child_session_id = ?,
        result_json = ?,
        error_json = ?,
        time_started = ?,
        time_updated = ?,
        time_completed = ?
      where id = ?
      `,
    )
    .run(
      input.status ?? current.status,
      input.childSessionId === undefined ? (current.childSessionId ?? null) : input.childSessionId,
      input.result === undefined ? encodeJson(current.result) : encodeJson(input.result),
      input.error === undefined ? encodeJson(current.error) : encodeJson(input.error),
      input.startedAt === undefined ? (current.startedAt ?? null) : input.startedAt,
      now,
      input.completedAt === undefined ? (current.completedAt ?? null) : input.completedAt,
      input.id,
    );
  return mustGetActivity(db, input.id);
}

export async function findCachedScriptWorkflowActivity(
  db: DatabaseSync,
  input: { callPath: string; inputHash: string; runId: string },
): Promise<ScriptWorkflowActivityRecord | null> {
  const row = db
    .prepare(
      `
      select * from workflow_activity
      where run_id = ? and call_path = ? and input_hash = ? and status in ('completed', 'cached')
      order by attempt desc
      limit 1
      `,
    )
    .get(input.runId, input.callPath, input.inputHash) as WorkflowActivityRow | undefined;
  return row ? decodeActivity(row) : null;
}

export async function listScriptWorkflowActivities(
  db: DatabaseSync,
  input: { runId: string },
): Promise<ScriptWorkflowActivityRecord[]> {
  const rows = db
    .prepare("select * from workflow_activity where run_id = ? order by call_index asc, id asc")
    .all(input.runId) as unknown as WorkflowActivityRow[];
  return rows.map(decodeActivity);
}

export async function appendScriptWorkflowEvent(
  db: DatabaseSync,
  input: {
    activityId?: string;
    id: string;
    payload?: unknown;
    phase?: string;
    runId: string;
    type: string;
  },
): Promise<ScriptWorkflowEventRecord> {
  const now = Date.now();
  const sequenceRow = db
    .prepare(
      `
      select coalesce(max(sequence), 0) + 1 as next_sequence
      from workflow_event where run_id = ?
      `,
    )
    .get(input.runId) as { next_sequence: number } | undefined;
  const sequence = sequenceRow?.next_sequence ?? 1;
  db
    .prepare(
      `
      insert into workflow_event (
        id, run_id, sequence, type, phase, activity_id, payload_json, time_created
      ) values (?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      input.id,
      input.runId,
      sequence,
      input.type,
      input.phase ?? null,
      input.activityId ?? null,
      encodeJson(input.payload),
      now,
    );
  return mustGetEvent(db, input.runId, sequence);
}

export async function listScriptWorkflowEvents(
  db: DatabaseSync,
  input: { limit?: number; runId: string },
): Promise<ScriptWorkflowEventRecord[]> {
  const limit = input.limit && input.limit > 0 ? input.limit : undefined;
  const rows = limit
    ? (db
        .prepare(
          `
          select * from (
            select * from workflow_event where run_id = ? order by sequence desc limit ?
          ) order by sequence asc
          `,
        )
        .all(input.runId, limit) as unknown as WorkflowEventRow[])
    : (db
        .prepare("select * from workflow_event where run_id = ? order by sequence asc")
        .all(input.runId) as unknown as WorkflowEventRow[]);
  return rows.map(decodeEvent);
}

export async function createSessionTaskLink(
  db: DatabaseSync,
  input: CreateSessionTaskLinkInput,
): Promise<SessionTaskLinkRecord> {
  const now = Date.now();
  db
    .prepare(
      `
      insert into session_task_link (
        id, root_workflow_run_id, parent_link_id, activity_id, parent_session_id,
        child_session_id, role, depth, path, phase, label, agent_type, model, status,
        time_created, time_updated
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(child_session_id) do update set
        status = excluded.status,
        time_updated = excluded.time_updated
      `,
    )
    .run(
      input.id,
      input.rootWorkflowRunId ?? null,
      input.parentLinkId ?? null,
      input.activityId ?? null,
      input.parentSessionId ?? null,
      input.childSessionId,
      input.role,
      input.depth ?? 0,
      input.path,
      input.phase ?? null,
      input.label ?? null,
      input.agentType ?? null,
      input.model ?? null,
      input.status,
      now,
      now,
    );
  return mustGetTaskLink(db, input.childSessionId);
}

async function getActivity(
  db: DatabaseSync,
  activityId: string,
): Promise<ScriptWorkflowActivityRecord | null> {
  const row = db.prepare("select * from workflow_activity where id = ?").get(activityId) as
    | WorkflowActivityRow
    | undefined;
  return row ? decodeActivity(row) : null;
}

async function mustGetActivity(
  db: DatabaseSync,
  activityId: string,
): Promise<ScriptWorkflowActivityRecord> {
  const activity = await getActivity(db, activityId);
  if (!activity) throw new Error(`Workflow activity not found after write: ${activityId}`);
  return activity;
}

async function mustGetEvent(
  db: DatabaseSync,
  runId: string,
  sequence: number,
): Promise<ScriptWorkflowEventRecord> {
  const row = db
    .prepare("select * from workflow_event where run_id = ? and sequence = ?")
    .get(runId, sequence) as WorkflowEventRow | undefined;
  if (!row) throw new Error(`Workflow event not found after write: ${runId}:${sequence}`);
  return decodeEvent(row);
}

async function mustGetTaskLink(
  db: DatabaseSync,
  childSessionId: SessionId,
): Promise<SessionTaskLinkRecord> {
  const row = db
    .prepare("select * from session_task_link where child_session_id = ?")
    .get(childSessionId) as SessionTaskLinkRow | undefined;
  if (!row) throw new Error(`Session task link not found after write: ${childSessionId}`);
  return decodeTaskLink(row);
}
