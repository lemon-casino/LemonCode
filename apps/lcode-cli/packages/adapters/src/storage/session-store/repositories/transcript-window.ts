import type { DatabaseSync } from "node:sqlite";
import type {
  MessagePart,
  ReadSessionTranscriptWindowInput,
  SessionTranscriptSnapshotLimits,
  SessionTranscriptWindow,
} from "@lcode/contracts";
import { decodeMessageRow, decodePartRow } from "../codecs.js";
import type { MessageRow } from "../rows.js";
import { getSession } from "./sessions.js";
import { admitRows, normalizeLimits, readPartRows } from "./transcript-snapshot.js";

const WINDOW_SAVEPOINT = "session_transcript_window";

interface MessageAnchor {
  sequence: number | null;
  time_created: number;
  storage_rowid: number;
}

interface BoundedMessageRow extends Omit<MessageRow, "data"> {
  data: string | null;
  data_bytes: number;
}

export function readTranscriptWindow(
  db: DatabaseSync,
  input: ReadSessionTranscriptWindowInput,
): SessionTranscriptWindow {
  const limits = normalizeLimits(input.limits);
  // 旧 prefix 在长会话中永远看不到刚完成的锚点；窗口与 rewind 元数据必须冻结在同一次读取中。
  db.exec(`savepoint ${WINDOW_SAVEPOINT}`);
  try {
    const window = readWindow(db, input, limits);
    db.exec(`release savepoint ${WINDOW_SAVEPOINT}`);
    return window;
  } catch (error) {
    try {
      db.exec(`rollback to savepoint ${WINDOW_SAVEPOINT}`);
      db.exec(`release savepoint ${WINDOW_SAVEPOINT}`);
    } catch {
      // 保留最初的读取错误，不用 savepoint 清理失败覆盖原因。
    }
    throw error;
  }
}

function readWindow(
  db: DatabaseSync,
  input: ReadSessionTranscriptWindowInput,
  limits: SessionTranscriptSnapshotLimits,
): SessionTranscriptWindow {
  const empty: SessionTranscriptWindow = {
    session: getSession(db, input.sessionID),
    throughMessageID: input.throughMessageID,
    boundaryFound: false,
    prefixTruncated: false,
    messages: [],
    loadedMessageCount: 0,
    loadedPartCount: 0,
    loadedDataBytes: 0,
    truncated: false,
  };
  if (!empty.session) return empty;
  const anchor = db
    .prepare(`select sequence, time_created, rowid as storage_rowid
      from message where id = ? and session_id = ?`)
    .get(input.throughMessageID, input.sessionID) as unknown as MessageAnchor | undefined;
  if (!anchor) return empty;

  // 只读最多 limit+1 个轻量 ID；多出的一行仅说明更早历史存在，不算窗口内部截断。
  // NULL sequence 排在所有非 NULL 之后，组内再按 time_created/rowid，不能用 ID 猜顺序。
  const candidates = db
    .prepare(`select id from message
      where session_id = ?
        and (sequence is null, coalesce(sequence, 0), time_created, rowid) <= (?, ?, ?, ?)
      order by sequence is null desc, sequence desc, time_created desc, rowid desc
      limit ?`)
    .all(
      input.sessionID,
      Number(anchor.sequence === null),
      anchor.sequence ?? 0,
      anchor.time_created,
      anchor.storage_rowid,
      limits.maxMessageRows + 1,
    ) as { id: string }[];
  const messageIDs = selectCompleteSuffix(db, input.sessionID, candidates, limits);
  if (messageIDs.length === 0) {
    return {
      ...empty,
      boundaryFound: true,
      prefixTruncated: candidates.length > 1,
      truncated: true,
    };
  }
  const boundedMessages = readMessageRows(db, input.sessionID, messageIDs, limits.maxDataBytes);
  const boundedParts = readPartRows(
    db,
    input.sessionID,
    boundedMessages.rows.map((row) => row.id),
    limits.maxPartRows,
    limits.maxDataBytes - boundedMessages.loadedDataBytes,
  );
  const partsByMessage = new Map<string, MessagePart[]>();
  for (const row of boundedParts.rows) {
    const parts = partsByMessage.get(row.message_id) ?? [];
    parts.push(decodePartRow(row));
    partsByMessage.set(row.message_id, parts);
  }
  const messages = boundedMessages.rows.map((row) => ({
    info: decodeMessageRow(row),
    parts: partsByMessage.get(row.id) ?? [],
  }));
  return {
    ...empty,
    boundaryFound: true,
    prefixTruncated: candidates.length > messageIDs.length,
    messages,
    loadedMessageCount: messages.length,
    loadedPartCount: boundedParts.rows.length,
    loadedDataBytes: boundedMessages.loadedDataBytes + boundedParts.loadedDataBytes,
    truncated: boundedMessages.truncated || boundedParts.truncated,
  };
}

function selectCompleteSuffix(
  db: DatabaseSync,
  sessionID: string,
  candidates: readonly { id: string }[],
  limits: SessionTranscriptSnapshotLimits,
): string[] {
  // 先装入消息、再升序分配 parts 会让旧巨大 Read 抢光新轮预算。
  // 从锚点逆序按完整 message+parts 准入；超额旧消息连同更早历史一起截掉，不留证据缺口。
  const measure = db.prepare(`
    select length(cast(data as blob)) as message_bytes,
      (select count(*) from part where session_id = m.session_id and message_id = m.id) as part_count,
      (select coalesce(sum(length(cast(data as blob))), 0) from part
        where session_id = m.session_id and message_id = m.id) as part_bytes
    from message m where session_id = ? and id = ?
  `);
  const selected: string[] = [];
  let dataBytes = 0;
  let partCount = 0;
  for (const candidate of candidates.slice(0, limits.maxMessageRows)) {
    // 只返回长度和数量，不把超额 JSON 带进 JS；同 savepoint 防止测量与读取之间发生改写。
    const size = measure.get(sessionID, candidate.id) as {
      message_bytes: number;
      part_count: number;
      part_bytes: number;
    };
    const nextBytes = dataBytes + size.message_bytes + size.part_bytes;
    const nextParts = partCount + size.part_count;
    if (nextBytes > limits.maxDataBytes || nextParts > limits.maxPartRows) break;
    selected.push(candidate.id);
    dataBytes = nextBytes;
    partCount = nextParts;
  }
  return selected;
}

function readMessageRows(
  db: DatabaseSync,
  sessionID: string,
  messageIDs: readonly string[],
  maxDataBytes: number,
): { rows: MessageRow[]; loadedDataBytes: number; truncated: boolean } {
  const placeholders = messageIDs.map(() => "?").join(", ");
  const rows = db
    .prepare(`
      with selected as (
        select rowid as storage_rowid, id, session_id, sequence, time_created, time_updated,
          length(cast(data as blob)) as data_bytes
        from message where session_id = ? and id in (${placeholders})
      ), measured as (
        select *,
          row_number() over (
            order by sequence is null, sequence, time_created, storage_rowid
          ) as ordinal,
          sum(data_bytes) over (
            order by sequence is null, sequence, time_created, storage_rowid
            rows between unbounded preceding and current row
          ) as cumulative_data_bytes
        from selected
      )
      select measured.id, measured.session_id, measured.sequence,
        measured.time_created, measured.time_updated,
        case when cumulative_data_bytes <= ? then m.data else null end as data,
        data_bytes
      from measured
      inner join message m on m.id = measured.id and m.session_id = measured.session_id
      where cumulative_data_bytes <= ?
        or ordinal = (
          select min(overflow.ordinal) from measured as overflow
          where overflow.cumulative_data_bytes > ?
        )
      order by ordinal
    `)
    .all(
      sessionID,
      ...messageIDs,
      maxDataBytes,
      maxDataBytes,
      maxDataBytes,
    ) as unknown as BoundedMessageRow[];
  return admitRows(rows);
}
