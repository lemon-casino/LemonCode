import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import {
  SESSION_TRANSCRIPT_SNAPSHOT_MAX_DATA_BYTES,
  SESSION_TRANSCRIPT_SNAPSHOT_MAX_MESSAGE_ROWS,
  SESSION_TRANSCRIPT_SNAPSHOT_MAX_PART_ROWS,
  type MessageId,
  type ProjectId,
  type SessionId,
  type SessionTranscriptSnapshotLimits,
  type SessionTranscriptWindow,
} from "@lcode/contracts";
import { createSqliteSessionStore, type SqliteSessionStore } from "../session-store.js";

const SESSION_ID = "sess_window" as SessionId;
const LIMITS: SessionTranscriptSnapshotLimits = {
  maxMessageRows: SESSION_TRANSCRIPT_SNAPSHOT_MAX_MESSAGE_ROWS,
  maxPartRows: SESSION_TRANSCRIPT_SNAPSHOT_MAX_PART_ROWS,
  maxDataBytes: SESSION_TRANSCRIPT_SNAPSHOT_MAX_DATA_BYTES,
};
// ID 字典序故意与插入顺序相反，确保同 sequence/time 的消息由 rowid 决定。
const messageID = (index: number): MessageId => `msg_${600 - index}` as MessageId;
const ids = (window: SessionTranscriptWindow) => window.messages.map((message) => message.info.id);

function readWindow(
  store: SqliteSessionStore,
  throughMessageID: MessageId,
  limits: Partial<SessionTranscriptSnapshotLimits> = {},
) {
  return store.readTranscriptWindow({
    sessionID: SESSION_ID,
    throughMessageID,
    limits: { ...LIMITS, ...limits },
  });
}

test("BTW-1 a 600-message window reaches its completed anchor without materializing history or future", async (t) => {
  await withStore(async (store, db) => {
    await seedTranscript(store, db, 600);
    db.prepare("update message set data = ? where sequence < ? or sequence > ?").run(
      "invalid excluded JSON",
      342,
      597,
    );
    t.mock.method(store, "messages", () => {
      throw new Error("unbounded fallback");
    });
    t.mock.method(store, "readTranscriptSnapshot", () => {
      throw new Error("prefix fallback");
    });
    const originalPrepare = DatabaseSync.prototype.prepare;
    const rowCounts: number[] = [];
    let returnedDataBytes = 0;
    t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
      const statement = originalPrepare.call(this, sql);
      if (this === db) return statement;
      const originalAll = statement.all.bind(statement);
      t.mock.method(statement, "all", (...parameters: SQLInputValue[]) => {
        const rows = originalAll(...parameters);
        rowCounts.push(rows.length);
        assert.ok(rows.length <= LIMITS.maxMessageRows + 1);
        for (const row of rows) {
          if (typeof row.data === "string") returnedDataBytes += Buffer.byteLength(row.data);
        }
        return rows;
      });
      return statement;
    });
    const window = await readWindow(store, messageID(597), {
      maxMessageRows: 10_000,
      maxPartRows: 10_000,
      maxDataBytes: 10_000_000,
    });
    assert.deepEqual(
      ids(window),
      Array.from({ length: 256 }, (_, index) => messageID(index + 342)),
    );
    assert.deepEqual(
      window.messages.slice(-2).map((message) => message.info.role),
      ["user", "assistant"],
    );
    assert.equal(window.throughMessageID, messageID(597));
    assert.equal(window.boundaryFound, true);
    assert.equal(window.prefixTruncated, true);
    assert.equal(window.truncated, false);
    assert.equal(window.loadedMessageCount, 256);
    assert.equal(window.loadedPartCount, 256);
    assert.equal(returnedDataBytes, window.loadedDataBytes);
    assert.ok(returnedDataBytes <= LIMITS.maxDataBytes);
    assert.ok(rowCounts.length > 0);
  });
});

test("BTW-2 prefix omission is independent of internal truncation and future rows", async () => {
  await withStore(async (store, db) => {
    await seedTranscript(store, db, 3);
    const full = await readWindow(store, messageID(1), { maxMessageRows: 2 });
    assert.deepEqual(ids(full), [messageID(0), messageID(1)]);
    assert.equal(full.prefixTruncated, false);
    assert.equal(full.truncated, false);
    const suffix = await readWindow(store, messageID(1), { maxMessageRows: 1 });
    assert.deepEqual(ids(suffix), [messageID(1)]);
    assert.equal(suffix.prefixTruncated, true);
    assert.equal(suffix.truncated, false);
  });
});

test("BTW-3 anchors use sequence, null-sequence, time and rowid ordering", async () => {
  await withStore(async (store, db) => {
    await seedTranscript(store, db, 8);
    const ordering = [
      [3, 50],
      [1, 99],
      [3, 10],
      [3, 50],
      [null, 1],
      [null, 1],
      [null, 0],
      [null, 2],
    ];
    const update = db.prepare("update message set sequence = ?, time_created = ? where id = ?");
    ordering.forEach(([sequence, created], index) =>
      update.run(sequence, created, messageID(index)),
    );
    for (const [anchor, limit, expected] of [
      [3, 3, [2, 0, 3]],
      [5, 4, [3, 6, 4, 5]],
      [4, 256, [1, 2, 0, 3, 6, 4]],
    ] as const) {
      const window = await readWindow(store, messageID(anchor), { maxMessageRows: limit });
      assert.deepEqual(ids(window), expected.map(messageID));
      assert.equal(window.boundaryFound, true);
      assert.equal(window.truncated, false);
      assert.equal(window.prefixTruncated, limit !== 256);
    }
  });
});

test("BTW-4 selected parts retain existing null/sequence/time/id ordering and row bounds", async () => {
  await withStore(async (store, db) => {
    await seedTranscript(store, db, 3);
    db.exec("delete from part");
    const insert = db.prepare(`insert into part
      (id, message_id, session_id, sequence, time_created, time_updated, data) values (?, ?, ?, ?, ?, 1, ?)`);
    for (const [id, sequence, created] of [
      ["z", 1, 3],
      ["a", 1, 3],
      ["early", 1, 1],
      ["null-z", null, 0],
      ["null-a", null, 0],
    ] as const) {
      insert.run(
        id,
        messageID(1),
        SESSION_ID,
        sequence,
        created,
        JSON.stringify({ type: "text", text: id }),
      );
    }
    db.prepare("update part set sequence = null where id like 'null-%'").run();
    insert.run("future", messageID(2), SESSION_ID, 0, 0, "invalid excluded JSON");
    const full = await readWindow(store, messageID(1), { maxMessageRows: 1 });
    assert.deepEqual(
      full.messages[0].parts.map((part) => part.id),
      ["early", "a", "z", "null-a", "null-z"],
    );
    assert.equal(full.truncated, false);
    const bounded = await readWindow(store, messageID(1), { maxMessageRows: 1, maxPartRows: 2 });
    assert.deepEqual(bounded.messages, []);
    assert.equal(bounded.boundaryFound, true);
    assert.equal(bounded.loadedDataBytes, 0);
    assert.equal(bounded.loadedPartCount, 0);
    assert.equal(bounded.prefixTruncated, true);
    assert.equal(bounded.truncated, true);
  });
});

test("BTW-5 combined UTF-8 bytes have exact boundaries and never silently drop later parts", async () => {
  await withStore(async (store, db) => {
    await seedTranscript(store, db, 2);
    const bytes = db
      .prepare(`select sum(length(cast(data as blob))) as bytes from
      (select data from message union all select data from part)`)
      .get()?.bytes as number;
    const complete = await readWindow(store, messageID(1), { maxDataBytes: bytes });
    assert.equal(complete.loadedDataBytes, bytes);
    assert.equal(complete.loadedPartCount, 2);
    assert.equal(complete.truncated, false);
    const suffix = await readWindow(store, messageID(1), { maxDataBytes: bytes - 1 });
    assert.deepEqual(ids(suffix), [messageID(1)]);
    assert.equal(suffix.loadedPartCount, 1);
    assert.equal(suffix.messages[0].parts[0].id, "part_1");
    assert.ok(suffix.loadedDataBytes <= bytes - 1);
    assert.equal(suffix.prefixTruncated, true);
    assert.equal(suffix.truncated, false);
    const noMessage = await readWindow(store, messageID(1), { maxDataBytes: 1 });
    assert.equal(noMessage.boundaryFound, true);
    assert.equal(noMessage.loadedMessageCount, 0);
    assert.equal(noMessage.loadedDataBytes, 0);
    assert.equal(noMessage.truncated, true);
  });
});

test("BTW-6 hard byte and part caps also apply to oversized caller limits", async () => {
  await withStore(async (store, db) => {
    await seedTranscript(store, db, 3);
    db.prepare("update part set data = ? where id = ?").run(
      JSON.stringify({ type: "text", text: "界".repeat(LIMITS.maxDataBytes) }),
      "part_2",
    );
    const bytes = await readWindow(store, messageID(2), {
      maxMessageRows: 2,
      maxDataBytes: 10_000_000,
    });
    assert.equal(bytes.boundaryFound, true);
    assert.equal(bytes.loadedMessageCount, 0);
    assert.equal(bytes.loadedPartCount, 0);
    assert.equal(bytes.loadedDataBytes, 0);
    assert.equal(bytes.prefixTruncated, true);
    assert.equal(bytes.truncated, true);
    db.exec("delete from part");
    const insert = db.prepare(`insert into part
      (id, message_id, session_id, sequence, time_created, time_updated, data) values (?, ?, ?, ?, 1, 1, ?)`);
    db.exec("begin");
    for (let index = 0; index <= LIMITS.maxPartRows; index += 1) {
      insert.run(`bounded_${index}`, messageID(2), SESSION_ID, index, '{"type":"text","text":"x"}');
    }
    db.exec("commit");
    const parts = await readWindow(store, messageID(2), { maxMessageRows: 1, maxPartRows: 10_000 });
    assert.equal(parts.loadedPartCount, 0);
    assert.equal(parts.loadedDataBytes, 0);
    assert.equal(parts.boundaryFound, true);
    assert.deepEqual(parts.messages, []);
    assert.equal(parts.truncated, true);
    assert.equal(parts.prefixTruncated, true);
  });
});

test("BTW-7 missing, foreign and deleted boundaries never return old prefix material", async () => {
  await withStore(async (store, db) => {
    await seedTranscript(store, db, 2);
    db.exec(
      "update message set data = 'invalid old JSON'; update part set data = 'invalid old JSON'",
    );
    for (const throughMessageID of ["absent", "' OR 1=1 --"] as MessageId[]) {
      const window = await readWindow(store, throughMessageID);
      assert.equal(window.session?.id, SESSION_ID);
      assert.equal(window.throughMessageID, throughMessageID);
      assert.equal(window.boundaryFound, false);
      assert.equal(window.prefixTruncated, false);
      assert.equal(window.truncated, false);
      assert.deepEqual(window.messages, []);
      assert.equal(window.loadedDataBytes, 0);
    }
    const missing = await store.readTranscriptWindow({
      sessionID: "sess_missing" as SessionId,
      throughMessageID: messageID(0),
      limits: LIMITS,
    });
    assert.equal(missing.session, null);
    assert.equal(missing.boundaryFound, false);
    assert.deepEqual(missing.messages, []);
    const { id: _id, ...metadata } = (await store.getSession(SESSION_ID))!;
    const foreignSessionID = "sess_foreign" as SessionId;
    await store.createSession({ ...metadata, id: foreignSessionID });
    const foreign = await store.readTranscriptWindow({
      sessionID: foreignSessionID,
      throughMessageID: messageID(0),
      limits: LIMITS,
    });
    assert.equal(foreign.session?.id, foreignSessionID);
    assert.equal(foreign.boundaryFound, false);
    assert.deepEqual(foreign.messages, []);
    await store.removeMessage({ sessionID: SESSION_ID, messageID: messageID(1) });
    const deleted = await readWindow(store, messageID(1));
    assert.equal(deleted.boundaryFound, false);
    assert.deepEqual(deleted.messages, []);
  });
});

test("BTW-8 current rewind metadata, anchor and parts share one SQLite read snapshot", async (t) => {
  await withStore(async (store, db) => {
    await seedTranscript(store, db, 2);
    const before = {
      messageID: messageID(0),
      kind: "conversation_rewind" as const,
      keptMessageIDs: [messageID(0), messageID(1)],
      branchCutAfterMessageID: messageID(1),
      branchGeneration: 1,
    };
    await store.setRevert({ sessionID: SESSION_ID, revert: before });
    const after = { ...before, keptMessageIDs: [messageID(0)], branchGeneration: 2 };
    const update = db.prepare("update session set revert = ? where id = ?");
    const remove = db.prepare("delete from message where id = ?");
    const changePart = db.prepare("update part set data = ? where id = ?");
    const originalPrepare = DatabaseSync.prototype.prepare;
    let changed = false;
    t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
      const statement = originalPrepare.call(this, sql);
      if (this === db || !/select \* from session where id = \?/i.test(sql)) return statement;
      const originalGet = statement.get.bind(statement);
      t.mock.method(statement, "get", (...parameters: SQLInputValue[]) => {
        const row = originalGet(...parameters);
        if (!changed) {
          changed = true;
          db.exec("begin immediate");
          update.run(JSON.stringify(after), SESSION_ID);
          remove.run(messageID(1));
          changePart.run('{"type":"text","text":"changed after snapshot"}', "part_0");
          db.exec("commit");
        }
        return row;
      });
      return statement;
    });
    const window = await readWindow(store, messageID(1));
    assert.equal(changed, true);
    assert.deepEqual(window.session?.revert, before);
    assert.equal(window.boundaryFound, true);
    assert.equal(window.truncated, false);
    assert.deepEqual(ids(window), [messageID(0), messageID(1)]);
    assert.deepEqual(
      window.messages.flatMap((message) =>
        message.parts.map((part) => (part.type === "text" ? part.text : "")),
      ),
      ["证据 0", "证据 1"],
    );
    const current = await readWindow(store, messageID(1));
    assert.deepEqual(current.session?.revert, after);
    assert.equal(current.boundaryFound, false);
    assert.deepEqual(current.messages, []);
  });
});

async function withStore(
  work: (store: SqliteSessionStore, db: DatabaseSync) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "lcode-transcript-window-"));
  const store = createSqliteSessionStore({ dbPath: join(directory, "sessions.db") });
  const db = new DatabaseSync(store.getDatabasePath());
  db.exec("pragma foreign_keys = on");
  try {
    await work(store, db);
  } finally {
    db.close();
    store.close();
    await rm(directory, { force: true, recursive: true });
  }
}

async function seedTranscript(
  store: SqliteSessionStore,
  db: DatabaseSync,
  count: number,
): Promise<void> {
  await store.createSession({
    id: SESSION_ID,
    projectID: "project-test" as ProjectId,
    slug: SESSION_ID,
    directory: tmpdir(),
    title: "Window test",
    version: "1",
  });
  const insertMessage = db.prepare(`insert into message
    (id, session_id, sequence, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?)`);
  const insertPart = db.prepare(`insert into part
    (id, message_id, session_id, sequence, time_created, time_updated, data) values (?, ?, ?, 0, ?, ?, ?)`);
  db.exec("begin");
  for (let index = 0; index < count; index += 1) {
    const info =
      index % 2 === 0
        ? { role: "user", agent: "build", time: { created: index } }
        : {
            role: "assistant",
            agent: "build",
            time: { created: index, completed: index + 1 },
            parentID: messageID(index - 1),
            mode: "build",
            path: { cwd: tmpdir(), root: tmpdir() },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          };
    insertMessage.run(messageID(index), SESSION_ID, index, index, index, JSON.stringify(info));
    insertPart.run(
      `part_${index}`,
      messageID(index),
      SESSION_ID,
      index,
      index,
      JSON.stringify({ type: "text", text: `证据 ${index}` }),
    );
  }
  db.exec("commit");
}
