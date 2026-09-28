import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type {
  CreateScriptWorkflowRunInput,
  ScriptWorkflowDefinitionRecord,
  ScriptWorkflowRunRecord,
  ScriptWorkflowRunStatus,
  UpsertScriptWorkflowDefinitionInput,
  UpdateScriptWorkflowRunInput,
} from "@lcode/contracts";
import { encodeJson } from "../json.js";
import {
  decodeDefinition,
  decodeRun,
  type WorkflowDefinitionRow,
  type WorkflowRunRow,
} from "./script-workflow-codecs.js";

export async function upsertScriptWorkflowDefinition(
  db: DatabaseSync,
  input: UpsertScriptWorkflowDefinitionInput,
): Promise<ScriptWorkflowDefinitionRecord> {
  const now = Date.now();
  db
    .prepare(
      `
      insert into workflow_definition (
        id, name, source, scope, trusted, enabled, script_path, script_hash, meta_json,
        time_created, time_updated
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(id) do update set
        name = excluded.name,
        source = excluded.source,
        scope = excluded.scope,
        trusted = excluded.trusted,
        enabled = excluded.enabled,
        script_path = excluded.script_path,
        script_hash = excluded.script_hash,
        meta_json = excluded.meta_json,
        time_updated = excluded.time_updated
      `,
    )
    .run(
      input.id,
      input.name,
      input.source,
      input.scope ?? (input.source === "builtin" ? "builtin" : "explicit"),
      input.trusted === true ? 1 : 0,
      input.enabled === false ? 0 : 1,
      input.scriptPath ?? null,
      input.scriptHash,
      JSON.stringify(input.meta),
      now,
      now,
    );
  return mustGetDefinition(db, input.id);
}

export async function createScriptWorkflowRun(
  db: DatabaseSync,
  input: CreateScriptWorkflowRunInput,
): Promise<ScriptWorkflowRunRecord> {
  const now = Date.now();
  db
    .prepare(
      `
      insert into workflow_run (
        id, definition_id, name, kind, parent_session_id, cwd, script_path, script_hash,
        args_json, args_hash, status, current_phase, budget_total, budget_spent,
        stats_json, failure_json, time_created, time_started, time_updated, time_completed
      ) values (?, ?, ?, 'script', ?, ?, ?, ?, ?, ?, ?, null, ?, 0, ?, null, ?, null, ?, null)
      `,
    )
    .run(
      input.id,
      input.definitionId ?? null,
      input.name,
      input.parentSessionId ?? null,
      input.cwd,
      input.scriptPath ?? null,
      input.scriptHash,
      encodeJson(input.args),
      input.argsHash ?? null,
      input.status ?? "pending",
      input.budgetTotal ?? null,
      encodeJson(input.stats),
      now,
      now,
    );
  return mustGetRun(db, input.id);
}

export async function updateScriptWorkflowRun(
  db: DatabaseSync,
  input: UpdateScriptWorkflowRunInput,
): Promise<ScriptWorkflowRunRecord> {
  const current = await getScriptWorkflowRun(db, input.id);
  if (!current) throw new Error(`Workflow run not found: ${input.id}`);
  const now = Date.now();
  db
    .prepare(
      `
      update workflow_run set
        status = ?,
        current_phase = ?,
        budget_spent = ?,
        stats_json = ?,
        failure_json = ?,
        time_started = ?,
        time_updated = ?,
        time_completed = ?
      where id = ?
      `,
    )
    .run(
      input.status ?? current.status,
      input.currentPhase === undefined ? (current.currentPhase ?? null) : input.currentPhase,
      input.budgetSpent ?? current.budgetSpent,
      input.stats === undefined ? encodeJson(current.stats) : encodeJson(input.stats),
      input.failure === undefined ? encodeJson(current.failure) : encodeJson(input.failure),
      input.startedAt === undefined ? (current.startedAt ?? null) : input.startedAt,
      now,
      input.completedAt === undefined ? (current.completedAt ?? null) : input.completedAt,
      input.id,
    );
  return mustGetRun(db, input.id);
}

export async function getScriptWorkflowRun(
  db: DatabaseSync,
  runId: string,
): Promise<ScriptWorkflowRunRecord | null> {
  const row = db.prepare("select * from workflow_run where id = ?").get(runId) as
    | WorkflowRunRow
    | undefined;
  return row ? decodeRun(row) : null;
}

export async function listScriptWorkflowRuns(
  db: DatabaseSync,
  input: {
    cwd?: string;
    limit?: number;
    statuses?: readonly ScriptWorkflowRunStatus[];
  } = {},
): Promise<ScriptWorkflowRunRecord[]> {
  const clauses: string[] = [];
  const values: SQLInputValue[] = [];
  if (input.cwd) {
    clauses.push("cwd = ?");
    values.push(input.cwd);
  }
  if (input.statuses && input.statuses.length > 0) {
    clauses.push(`status in (${input.statuses.map(() => "?").join(", ")})`);
    values.push(...input.statuses);
  }
  const limit = input.limit && input.limit > 0 ? input.limit : undefined;
  if (limit !== undefined) values.push(limit);
  const where = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";
  const limitSql = limit === undefined ? "" : " limit ?";
  const rows = db
    .prepare(`select * from workflow_run ${where} order by time_updated desc, id desc${limitSql}`)
    .all(...values) as unknown as WorkflowRunRow[];
  return rows.map(decodeRun);
}

async function mustGetDefinition(
  db: DatabaseSync,
  definitionId: string,
): Promise<ScriptWorkflowDefinitionRecord> {
  const row = db.prepare("select * from workflow_definition where id = ?").get(definitionId) as
    | WorkflowDefinitionRow
    | undefined;
  if (!row) throw new Error(`Workflow definition not found after write: ${definitionId}`);
  return decodeDefinition(row);
}

async function mustGetRun(db: DatabaseSync, runId: string): Promise<ScriptWorkflowRunRecord> {
  const run = await getScriptWorkflowRun(db, runId);
  if (!run) throw new Error(`Workflow run not found after write: ${runId}`);
  return run;
}
