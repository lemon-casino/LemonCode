import type { DatabaseSync } from "node:sqlite";
import type { CollaborationMode, PermissionRuleset, ProjectId } from "@lcode/contracts";
import { isCollaborationMode } from "../codecs.js";
import { decodeJson } from "../json.js";
import type { LocalSettingRow, PermissionRow } from "../rows.js";

export async function getProjectPermission(
  db: DatabaseSync,
  projectID: ProjectId,
): Promise<PermissionRuleset | null> {
  const setting = readLocalSetting(db, {
    key: "ruleset",
    namespace: "permission",
    scope: "project",
    scopeID: projectID,
  });
  if (setting) {
    return decodeJson<PermissionRuleset>(setting.value) ?? null;
  }

  const row = db.prepare("select * from permission where project_id = ?").get(projectID) as
    | PermissionRow
    | undefined;
  return row ? (decodeJson<PermissionRuleset>(row.data) ?? null) : null;
}

export async function saveProjectPermission(
  db: DatabaseSync,
  input: {
    projectID: ProjectId;
    permission: PermissionRuleset;
  },
): Promise<PermissionRuleset> {
  const now = Date.now();
  writeLocalSetting(db, {
    key: "ruleset",
    namespace: "permission",
    schemaVersion: 1,
    scope: "project",
    scopeID: input.projectID,
    time: now,
    value: JSON.stringify(input.permission),
  });

  const saved = await getProjectPermission(db, input.projectID);
  if (!saved) {
    throw new Error(`Project permission not found after write: ${input.projectID}`);
  }
  return saved;
}

export function getProjectPermissionMode(
  db: DatabaseSync,
  projectID: ProjectId,
): CollaborationMode | null {
  const setting = readLocalSetting(db, {
    key: "mode",
    namespace: "permission",
    scope: "project",
    scopeID: projectID,
  });
  if (!setting) return null;

  const value = decodeJson<{ mode?: unknown }>(setting.value);
  return isCollaborationMode(value?.mode) ? value.mode : null;
}

export function saveProjectPermissionMode(
  db: DatabaseSync,
  input: {
    mode: CollaborationMode;
    projectID: ProjectId;
  },
): CollaborationMode {
  const now = Date.now();
  writeLocalSetting(db, {
    key: "mode",
    namespace: "permission",
    schemaVersion: 1,
    scope: "project",
    scopeID: input.projectID,
    time: now,
    value: JSON.stringify({ mode: input.mode }),
  });
  return input.mode;
}

function readLocalSetting(
  db: DatabaseSync,
  input: {
    key: string;
    namespace: string;
    scope: string;
    scopeID: string;
  },
): LocalSettingRow | undefined {
  return db
    .prepare(
      `
      select value from local_setting
      where scope = ? and scope_id = ? and namespace = ? and key = ?
      `,
    )
    .get(input.scope, input.scopeID, input.namespace, input.key) as LocalSettingRow | undefined;
}

function writeLocalSetting(
  db: DatabaseSync,
  input: {
    key: string;
    namespace: string;
    schemaVersion: number;
    scope: string;
    scopeID: string;
    time: number;
    value: string;
  },
): void {
  db.prepare(
    `
      insert into local_setting (
        scope, scope_id, namespace, key, value, schema_version, time_created, time_updated
      ) values (?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(scope, scope_id, namespace, key) do update set
        value = excluded.value,
        schema_version = excluded.schema_version,
        time_updated = excluded.time_updated
      `,
  ).run(
    input.scope,
    input.scopeID,
    input.namespace,
    input.key,
    input.value,
    input.schemaVersion,
    input.time,
    input.time,
  );
}
