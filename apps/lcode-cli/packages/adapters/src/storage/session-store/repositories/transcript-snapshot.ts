import type { DatabaseSync } from "node:sqlite";
import {
  SESSION_TRANSCRIPT_SNAPSHOT_MAX_DATA_BYTES,
  SESSION_TRANSCRIPT_SNAPSHOT_MAX_MESSAGE_ROWS,
  SESSION_TRANSCRIPT_SNAPSHOT_MAX_PART_ROWS,
  type MessagePart,
  type MessageWithParts,
  type ReadSessionTranscriptSnapshotInput,
  type SessionTranscriptSnapshot,
  type SessionTranscriptSnapshotLimits,
} from "@lcode/contracts";
import { decodeMessageRow, decodePartRow } from "../codecs.js";
import type { MessageRow, PartRow } from "../rows.js";
import { getSession } from "./sessions.js";

const SNAPSHOT_SAVEPOINT = "session_transcript_snapshot";

interface BoundedMessageRow extends Omit<MessageRow, "data"> {
  data: string | null;
  data_bytes: number;
  ordinal: number;
}

interface BoundedPartRow extends Omit<PartRow, "data"> {
  data: string | null;
  data_bytes: number;
  ordinal: number;
}

export function readTranscriptSnapshot(
  db: DatabaseSync,
  input: ReadSessionTranscriptSnapshotInput,
): SessionTranscriptSnapshot {
  const limits = normalizeLimits(input.limits);
  db.exec(`savepoint ${SNAPSHOT_SAVEPOINT}`);
  try {
    const session = getSession(db, input.sessionID);
    if (!session) {
      releaseSavepoint(db);
      return emptySnapshot();
    }

    const boundedMessages = readMessageRows(db, input.sessionID, limits);
    const remainingDataBytes = limits.maxDataBytes - boundedMessages.loadedDataBytes;
    const boundedParts = readPartRows(
      db,
      input.sessionID,
      boundedMessages.rows.map((row) => row.id),
      limits.maxPartRows,
      remainingDataBytes,
    );
    releaseSavepoint(db);

    const partsByMessage = new Map<string, MessagePart[]>();
    for (const row of boundedParts.rows) {
      const list = partsByMessage.get(row.message_id) ?? [];
      list.push(decodePartRow(row));
      partsByMessage.set(row.message_id, list);
    }
    const messages: MessageWithParts[] = boundedMessages.rows.map((row) => ({
      info: decodeMessageRow(row),
      parts: partsByMessage.get(row.id) ?? [],
    }));

    return {
      session,
      messages,
      loadedMessageCount: messages.length,
      loadedPartCount: boundedParts.rows.length,
      loadedDataBytes: boundedMessages.loadedDataBytes + boundedParts.loadedDataBytes,
      truncated: boundedMessages.truncated || boundedParts.truncated,
    };
  } catch (error) {
    rollbackSavepoint(db);
    throw error;
  }
}

function readMessageRows(
  db: DatabaseSync,
  sessionID: string,
  limits: SessionTranscriptSnapshotLimits,
): { rows: MessageRow[]; loadedDataBytes: number; truncated: boolean } {
  const rows = db
    .prepare(
      `
      with prefix as (
        select
          rowid as storage_rowid,
          id,
          session_id,
          sequence,
          time_created,
          time_updated,
          data
        from message
        where session_id = ?
        order by sequence is null, sequence, time_created, rowid
        limit ?
      ), measured as (
        select
          *,
          row_number() over (
            order by sequence is null, sequence, time_created, storage_rowid
          ) as ordinal,
          length(cast(data as blob)) as data_bytes,
          sum(length(cast(data as blob))) over (
            order by sequence is null, sequence, time_created, storage_rowid
            rows between unbounded preceding and current row
          ) as cumulative_data_bytes
        from prefix
      )
      select
        id,
        session_id,
        sequence,
        time_created,
        time_updated,
        case when ordinal <= ? and cumulative_data_bytes <= ? then data else null end as data,
        data_bytes,
        ordinal
      from measured
      where
        cumulative_data_bytes <= ?
        or ordinal = (
          select min(overflow.ordinal)
          from measured as overflow
          where overflow.cumulative_data_bytes > ?
        )
      order by ordinal
      `,
    )
    .all(
      sessionID,
      limits.maxMessageRows + 1,
      limits.maxMessageRows,
      limits.maxDataBytes,
      limits.maxDataBytes,
      limits.maxDataBytes,
    ) as unknown as BoundedMessageRow[];

  return admitRows(rows);
}

export function readPartRows(
  db: DatabaseSync,
  sessionID: string,
  messageIDs: readonly string[],
  maxPartRows: number,
  maxDataBytes: number,
): { rows: PartRow[]; loadedDataBytes: number; truncated: boolean } {
  if (messageIDs.length === 0) {
    return { rows: [], loadedDataBytes: 0, truncated: false };
  }
  const placeholders = messageIDs.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `
      with prefix as (
        select
          p.id,
          p.message_id,
          p.session_id,
          p.sequence,
          p.time_created,
          p.time_updated,
          p.data,
          m.sequence as message_sequence,
          m.time_created as message_time_created,
          m.rowid as message_rowid
        from part p
        inner join message m on m.id = p.message_id and m.session_id = p.session_id
        where p.session_id = ? and p.message_id in (${placeholders})
        order by
          m.sequence is null,
          m.sequence,
          m.time_created,
          m.rowid,
          p.sequence is null,
          p.sequence,
          p.time_created,
          p.id
        limit ?
      ), measured as (
        select
          *,
          row_number() over (
            order by
              message_sequence is null,
              message_sequence,
              message_time_created,
              message_rowid,
              sequence is null,
              sequence,
              time_created,
              id
          ) as ordinal,
          length(cast(data as blob)) as data_bytes,
          sum(length(cast(data as blob))) over (
            order by
              message_sequence is null,
              message_sequence,
              message_time_created,
              message_rowid,
              sequence is null,
              sequence,
              time_created,
              id
            rows between unbounded preceding and current row
          ) as cumulative_data_bytes
        from prefix
      )
      select
        id,
        message_id,
        session_id,
        sequence,
        time_created,
        time_updated,
        case when ordinal <= ? and cumulative_data_bytes <= ? then data else null end as data,
        data_bytes,
        ordinal
      from measured
      where
        cumulative_data_bytes <= ?
        or ordinal = (
          select min(overflow.ordinal)
          from measured as overflow
          where overflow.cumulative_data_bytes > ?
        )
      order by ordinal
      `,
    )
    .all(
      sessionID,
      ...messageIDs,
      maxPartRows + 1,
      maxPartRows,
      Math.max(0, maxDataBytes),
      Math.max(0, maxDataBytes),
      Math.max(0, maxDataBytes),
    ) as unknown as BoundedPartRow[];

  return admitRows(rows);
}

export function admitRows<Row extends { data: string | null; data_bytes: number }>(
  candidates: readonly Row[],
): { rows: Array<Row & { data: string }>; loadedDataBytes: number; truncated: boolean } {
  const rows: Array<Row & { data: string }> = [];
  let loadedDataBytes = 0;
  for (const row of candidates) {
    if (row.data === null) {
      return { rows, loadedDataBytes, truncated: true };
    }
    rows.push(row as Row & { data: string });
    loadedDataBytes += row.data_bytes;
  }
  return { rows, loadedDataBytes, truncated: false };
}

export function normalizeLimits(
  input: SessionTranscriptSnapshotLimits,
): SessionTranscriptSnapshotLimits {
  return {
    maxMessageRows: positiveLimit(
      input.maxMessageRows,
      SESSION_TRANSCRIPT_SNAPSHOT_MAX_MESSAGE_ROWS,
    ),
    maxPartRows: positiveLimit(input.maxPartRows, SESSION_TRANSCRIPT_SNAPSHOT_MAX_PART_ROWS),
    maxDataBytes: positiveLimit(input.maxDataBytes, SESSION_TRANSCRIPT_SNAPSHOT_MAX_DATA_BYTES),
  };
}

function positiveLimit(value: number, maximum: number): number {
  if (!Number.isFinite(value)) return maximum;
  return Math.max(1, Math.min(maximum, Math.trunc(value)));
}

function emptySnapshot(): SessionTranscriptSnapshot {
  return {
    session: null,
    messages: [],
    loadedMessageCount: 0,
    loadedPartCount: 0,
    loadedDataBytes: 0,
    truncated: false,
  };
}

function releaseSavepoint(db: DatabaseSync): void {
  db.exec(`release savepoint ${SNAPSHOT_SAVEPOINT}`);
}

function rollbackSavepoint(db: DatabaseSync): void {
  try {
    db.exec(`rollback to savepoint ${SNAPSHOT_SAVEPOINT}`);
    releaseSavepoint(db);
  } catch {
    // 原始读取错误才是调用方需要处理的原因。
  }
}
