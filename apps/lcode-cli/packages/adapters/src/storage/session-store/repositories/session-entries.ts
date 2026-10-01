import type { DatabaseSync } from "node:sqlite";
import {
  SESSION_ENTRY_MODEL_SELECTION,
  type SessionEntryInfo,
  type SessionEntryType,
  type SessionId,
} from "@lcode/contracts";
import { decodeSessionEntryRow } from "../codecs.js";
import { encodeJson } from "../json.js";
import type { SessionEntryRow } from "../rows.js";
import { touchSession } from "./sessions.js";

export function saveSessionEntry(db: DatabaseSync, input: SessionEntryInfo): void {
  const isModelSelection = input.type === SESSION_ENTRY_MODEL_SELECTION;
  // 旧版读取 data 的平铺身份；新版 port 仍传逻辑 Selection，包装只属于存储 adapter。
  // undefined 与既有 fork 的 null 都写成明确空值，防止重启重新导入旧字段。
  const encoded = encodeJson(
    isModelSelection ? { modelSelection: input.data ?? null } : input.data,
  );
  if (!encoded) {
    throw new Error("Session entry data must be JSON-serializable");
  }

  db.prepare(
    `
      insert into session_entry (id, session_id, type, time_created, time_updated, data)
      values (?, ?, ?, ?, ?, ?)
      on conflict(id) do update set
        session_id = excluded.session_id,
        type = excluded.type,
        time_updated = excluded.time_updated,
        data = case
          when ? and session_entry.type = excluded.type
            and session_entry.session_id = excluded.session_id
            and json_type(session_entry.data) = 'object'
          then json_set(session_entry.data, '$.modelSelection', json_extract(excluded.data, '$.modelSelection'))
          else excluded.data
        end
      `,
  ).run(
    input.id,
    input.sessionID,
    input.type,
    input.time.created,
    input.time.updated,
    encoded,
    Number(isModelSelection),
  );
  if (input.touchSession !== false) {
    touchSession(db, input.sessionID, input.time.updated);
  }
}

export function sessionEntries(
  db: DatabaseSync,
  input: { sessionID: SessionId; type?: SessionEntryType | string; limit?: number },
): SessionEntryInfo[] {
  const rows = input.type
    ? db
        .prepare(
          `
          select * from session_entry
          where session_id = ? and type = ?
          order by time_created, rowid limit ?
          `,
        )
        .all(
          input.sessionID,
          input.type,
          input.limit === undefined ? -1 : Math.max(1, Math.min(10_000, Math.trunc(input.limit))),
        )
    : db
        .prepare(
          `
          select * from session_entry
          where session_id = ?
          order by time_created, rowid limit ?
          `,
        )
        .all(
          input.sessionID,
          input.limit === undefined ? -1 : Math.max(1, Math.min(10_000, Math.trunc(input.limit))),
        );

  return (rows as unknown as SessionEntryRow[]).map(decodeSessionEntryRow);
}
