import type {
  ScriptWorkflowActivityRecord,
  ScriptWorkflowActivityStatus,
  ScriptWorkflowDefinitionRecord,
  ScriptWorkflowEventRecord,
  ScriptWorkflowRunRecord,
  ScriptWorkflowRunStatus,
  SessionId,
  SessionTaskLinkRecord,
  WorkflowAgentOptions,
  WorkflowScriptMeta,
} from "@lcode/contracts";
import { decodeJson } from "../json.js";

export interface WorkflowDefinitionRow {
  enabled: number;
  id: string;
  meta_json: string;
  name: string;
  scope: "builtin" | "explicit" | "project" | "user";
  script_hash: string;
  script_path: string | null;
  source: "builtin" | "user";
  time_created: number;
  time_updated: number;
  trusted: number;
}

export interface WorkflowRunRow {
  args_hash: string | null;
  args_json: string | null;
  budget_spent: number;
  budget_total: number | null;
  current_phase: string | null;
  cwd: string;
  definition_id: string | null;
  failure_json: string | null;
  id: string;
  kind: "script";
  name: string;
  parent_session_id: SessionId | null;
  script_hash: string;
  script_path: string | null;
  stats_json: string | null;
  status: ScriptWorkflowRunStatus;
  time_completed: number | null;
  time_created: number;
  time_started: number | null;
  time_updated: number;
}

export interface WorkflowActivityRow {
  attempt: number;
  call_index: number;
  call_path: string;
  child_session_id: SessionId | null;
  error_json: string | null;
  id: string;
  input_hash: string;
  label: string | null;
  opts_json: string | null;
  parent_activity_id: string | null;
  phase: string | null;
  prompt: string | null;
  result_json: string | null;
  run_id: string;
  status: ScriptWorkflowActivityStatus;
  time_completed: number | null;
  time_created: number;
  time_started: number | null;
  time_updated: number;
  type: ScriptWorkflowActivityRecord["type"];
}

export interface WorkflowEventRow {
  activity_id: string | null;
  id: string;
  payload_json: string | null;
  phase: string | null;
  run_id: string;
  sequence: number;
  time_created: number;
  type: string;
}

export interface SessionTaskLinkRow {
  activity_id: string | null;
  agent_type: string | null;
  child_session_id: SessionId;
  depth: number;
  id: string;
  label: string | null;
  model: string | null;
  parent_link_id: string | null;
  parent_session_id: SessionId | null;
  path: string;
  phase: string | null;
  role: string;
  root_workflow_run_id: string | null;
  status: string;
  time_created: number;
  time_updated: number;
}

export function decodeDefinition(row: WorkflowDefinitionRow): ScriptWorkflowDefinitionRecord {
  return {
    enabled: row.enabled === 1,
    id: row.id,
    meta: JSON.parse(row.meta_json) as WorkflowScriptMeta,
    name: row.name,
    scope: row.scope,
    scriptHash: row.script_hash,
    scriptPath: row.script_path ?? undefined,
    source: row.source,
    timeCreated: row.time_created,
    timeUpdated: row.time_updated,
    trusted: row.trusted === 1,
  };
}

export function decodeRun(row: WorkflowRunRow): ScriptWorkflowRunRecord {
  return {
    args: decodeJson(row.args_json),
    argsHash: row.args_hash ?? undefined,
    budgetSpent: row.budget_spent,
    budgetTotal: row.budget_total ?? undefined,
    completedAt: row.time_completed ?? undefined,
    createdAt: row.time_created,
    currentPhase: row.current_phase ?? undefined,
    cwd: row.cwd,
    definitionId: row.definition_id ?? undefined,
    failure: decodeJson(row.failure_json),
    id: row.id,
    kind: row.kind,
    name: row.name,
    parentSessionId: row.parent_session_id ?? undefined,
    scriptHash: row.script_hash,
    scriptPath: row.script_path ?? undefined,
    startedAt: row.time_started ?? undefined,
    stats: decodeJson(row.stats_json),
    status: row.status,
    updatedAt: row.time_updated,
  };
}

export function decodeActivity(row: WorkflowActivityRow): ScriptWorkflowActivityRecord {
  return {
    attempt: row.attempt,
    callIndex: row.call_index,
    callPath: row.call_path,
    childSessionId: row.child_session_id ?? undefined,
    completedAt: row.time_completed ?? undefined,
    createdAt: row.time_created,
    error: decodeJson(row.error_json),
    id: row.id,
    inputHash: row.input_hash,
    label: row.label ?? undefined,
    opts: decodeJson<WorkflowAgentOptions>(row.opts_json),
    parentActivityId: row.parent_activity_id ?? undefined,
    phase: row.phase ?? undefined,
    prompt: row.prompt ?? undefined,
    result: decodeJson(row.result_json),
    runId: row.run_id,
    startedAt: row.time_started ?? undefined,
    status: row.status,
    type: row.type,
    updatedAt: row.time_updated,
  };
}

export function decodeEvent(row: WorkflowEventRow): ScriptWorkflowEventRecord {
  return {
    activityId: row.activity_id ?? undefined,
    createdAt: row.time_created,
    id: row.id,
    payload: decodeJson(row.payload_json),
    phase: row.phase ?? undefined,
    runId: row.run_id,
    sequence: row.sequence,
    type: row.type,
  };
}

export function decodeTaskLink(row: SessionTaskLinkRow): SessionTaskLinkRecord {
  return {
    activityId: row.activity_id ?? undefined,
    agentType: row.agent_type ?? undefined,
    childSessionId: row.child_session_id,
    createdAt: row.time_created,
    depth: row.depth,
    id: row.id,
    label: row.label ?? undefined,
    model: row.model ?? undefined,
    parentLinkId: row.parent_link_id ?? undefined,
    parentSessionId: row.parent_session_id ?? undefined,
    path: row.path,
    phase: row.phase ?? undefined,
    role: row.role,
    rootWorkflowRunId: row.root_workflow_run_id ?? undefined,
    status: row.status,
    updatedAt: row.time_updated,
  };
}
