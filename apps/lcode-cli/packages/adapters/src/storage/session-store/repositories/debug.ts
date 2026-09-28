import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { SessionId } from "@lcode/contracts";
import type { SessionStoreDebugCounts } from "../options.js";

export function debugMigrationIds(db: DatabaseSync): string[] {
  return (
    db.prepare("select id from schema_migration order by id").all() as Array<{ id: string }>
  ).map((row) => row.id);
}

export function debugCounts(db: DatabaseSync, sessionID?: SessionId): SessionStoreDebugCounts {
  const scoped = sessionID ? " where session_id = ?" : "";
  const values = sessionID ? [sessionID] : [];
  return {
    sessions: count(db, "session", sessionID ? " where id = ?" : "", values),
    messages: count(db, "message", scoped, values),
    parts: count(db, "part", scoped, values),
    todos: count(db, "todo", scoped, values),
    targets: count(db, "session_target", scoped, values),
    sessionEntries: count(db, "session_entry", scoped, values),
    permissions: count(db, "permission", "", []),
    localSettings: count(db, "local_setting", "", []),
    schemaMigrations: count(db, "schema_migration", "", []),
    inputHistory: count(db, "input_history", scoped, values),
    modelUsage: count(db, "model_usage", scoped, values),
    toolUsage: count(db, "tool_usage", scoped, values),
    turnUsage: count(db, "turn_usage", scoped, values),
  };
}

function count(db: DatabaseSync, table: string, where: string, values: SQLInputValue[]): number {
  const row = db.prepare(`select count(*) as count from ${table}${where}`).get(...values) as {
    count: number;
  };
  return row.count;
}
