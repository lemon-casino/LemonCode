import type { DatabaseSync } from "node:sqlite";
import type {
  InputHistoryAttachment,
  InputHistoryEntry,
  InputHistoryKind,
  ProjectId,
  SessionId,
} from "@lcode/contracts";
import { decodeJson, encodeJson } from "../json.js";
import type { InputHistoryRow } from "../rows.js";

const INPUT_HISTORY_LIMIT = 100;

export async function recordInputHistory(
  db: DatabaseSync,
  input: {
    projectID: ProjectId;
    sessionID?: SessionId;
    text: string;
    attachments?: InputHistoryAttachment[];
    kind: InputHistoryKind;
    time?: { created?: number };
  },
): Promise<InputHistoryEntry | null> {
  const text = input.text.trim();
  if (text.length === 0) return null;
  const attachments = normalizedInputHistoryAttachments(input.attachments);

  const latest = await recallPreviousInputHistory(db, { projectID: input.projectID });
  if (
    latest?.text === text &&
    stableInputHistoryAttachments(latest.attachments) === stableInputHistoryAttachments(attachments)
  ) {
    return null;
  }

  const id = createStorageInputHistoryId();
  const timeCreated = input.time?.created ?? Date.now();

  db.exec("begin immediate");
  try {
    db
      .prepare(
        `
        insert into input_history (id, project_id, session_id, text, attachments, kind, time_created)
        values (?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        id,
        input.projectID,
        input.sessionID ?? null,
        text,
        encodeJson(attachments),
        input.kind,
        timeCreated,
      );
    db
      .prepare(
        `
        delete from input_history
        where id not in (
          select id from input_history
          order by time_created desc, id desc
          limit ?
        )
        `,
      )
      .run(INPUT_HISTORY_LIMIT);
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }

  return {
    id,
    projectID: input.projectID,
    sessionID: input.sessionID,
    text,
    ...(attachments ? { attachments } : {}),
    kind: input.kind,
    time: {
      created: timeCreated,
    },
  };
}

export async function recallPreviousInputHistory(
  db: DatabaseSync,
  input: {
    projectID: ProjectId;
    skip?: number;
  },
): Promise<InputHistoryEntry | null> {
  const skipCount = input.skip ?? 0;
  const row = db
    .prepare(
      `
      select * from input_history
      where project_id = ?
      order by time_created desc, id desc
      limit 1 offset ?
      `,
    )
    .get(input.projectID, skipCount) as InputHistoryRow | undefined;
  return row ? decodeInputHistoryRow(row) : null;
}

function decodeInputHistoryRow(row: InputHistoryRow): InputHistoryEntry {
  const attachments = normalizedInputHistoryAttachments(
    decodeJson<InputHistoryAttachment[]>(row.attachments),
  );
  return {
    id: row.id as InputHistoryEntry["id"],
    projectID: row.project_id as ProjectId,
    sessionID: row.session_id ? (row.session_id as SessionId) : undefined,
    text: row.text,
    ...(attachments ? { attachments } : {}),
    kind: row.kind as InputHistoryKind,
    time: {
      created: row.time_created,
    },
  };
}

function normalizedInputHistoryAttachments(
  attachments: InputHistoryAttachment[] | undefined,
): InputHistoryAttachment[] | undefined {
  const normalized = (attachments ?? [])
    .map((attachment): InputHistoryAttachment | undefined => {
      if (
        attachment.type !== "file" &&
        attachment.type !== "image" &&
        attachment.type !== "pdf" &&
        attachment.type !== "url"
      ) {
        return undefined;
      }
      const path = normalizedOptionalString(attachment.path);
      const content = normalizedAttachmentContent(attachment.content);
      if (!path && !content) return undefined;
      return {
        type: attachment.type,
        ...(path ? { path } : {}),
        ...(content ? { content } : {}),
      };
    })
    .filter((attachment): attachment is InputHistoryAttachment => attachment !== undefined);

  return normalized.length > 0 ? normalized : undefined;
}

function normalizedOptionalString(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizedAttachmentContent(value: string | undefined): string | undefined {
  const normalized = normalizedOptionalString(value);
  if (!normalized) return undefined;
  return normalized.startsWith("data:") ? undefined : normalized;
}

function stableInputHistoryAttachments(attachments: InputHistoryAttachment[] | undefined): string {
  return JSON.stringify(normalizedInputHistoryAttachments(attachments) ?? []);
}

function createStorageInputHistoryId(): InputHistoryEntry["id"] {
  return `input_${Date.now().toString(36)}_${crypto.randomUUID()}` as InputHistoryEntry["id"];
}
