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
  type PartId,
  type ProjectId,
  type SessionId,
  type SessionTranscriptSnapshotLimits,
} from "@lcode/contracts";
import { createSqliteSessionStore, type SqliteSessionStore } from "../session-store.js";

const SESSION_ID = "sess_window_budget" as SessionId;
const LIMITS: SessionTranscriptSnapshotLimits = {
  maxMessageRows: SESSION_TRANSCRIPT_SNAPSHOT_MAX_MESSAGE_ROWS,
  maxPartRows: SESSION_TRANSCRIPT_SNAPSHOT_MAX_PART_ROWS,
  maxDataBytes: SESSION_TRANSCRIPT_SNAPSHOT_MAX_DATA_BYTES,
};
const messageID = (index: number): MessageId => `budget_${index}` as MessageId;

for (const overflow of ["part bytes", "message bytes", "part count"] as const) {
  test(`BTW-9 ${overflow} in older history cannot starve the latest complete turn`, async (t) => {
    await withStore(async (store, db) => {
      await seedTranscript(store, 4);
      if (overflow === "part bytes") {
        await store.savePart({
          id: "part_1" as PartId,
          messageID: messageID(1),
          sessionID: SESSION_ID,
          type: "tool",
          tool: "Read",
          callID: "old_read",
          state: {
            status: "completed",
            input: {},
            metadata: {},
            title: "Old read",
            output: "x".repeat(LIMITS.maxDataBytes + 1),
            time: { start: 1, end: 2 },
          },
        });
      } else if (overflow === "message bytes") {
        db.prepare("update message set data = ? where id = ?").run(
          JSON.stringify({
            role: "assistant",
            metadata: { old: "x".repeat(LIMITS.maxDataBytes + 1) },
          }),
          messageID(1),
        );
      } else {
        const insert = db.prepare(`insert into part
          (id, message_id, session_id, sequence, time_created, time_updated, data)
          values (?, ?, ?, ?, 1, 1, ?)`);
        db.exec("begin");
        for (let index = 0; index < LIMITS.maxPartRows; index += 1) {
          insert.run(
            `old_${index}`,
            messageID(1),
            SESSION_ID,
            index + 1,
            '{"type":"text","text":"old"}',
          );
        }
        db.exec("commit");
      }
      const prepare = DatabaseSync.prototype.prepare;
      let returnedBytes = 0;
      t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
        const statement = prepare.call(this, sql);
        if (this === db) return statement;
        const all = statement.all.bind(statement);
        t.mock.method(statement, "all", (...parameters: SQLInputValue[]) => {
          const rows = all(...parameters);
          for (const row of rows) {
            if (typeof row.data === "string") {
              returnedBytes += Buffer.byteLength(row.data);
              assert.ok(
                row.id === messageID(2) ||
                  row.id === messageID(3) ||
                  row.id === "part_2" ||
                  row.id === "part_3",
                "excluded history JSON must never be loaded into the window",
              );
            }
          }
          return rows;
        });
        return statement;
      });
      const read = () =>
        store.readTranscriptWindow({
          sessionID: SESSION_ID,
          throughMessageID: messageID(3),
          limits: LIMITS,
        });
      const window = await read();
      assert.deepEqual(
        window.messages.map((message) => message.info.id),
        [messageID(2), messageID(3)],
      );
      assert.deepEqual(
        window.messages.flatMap((message) =>
          message.parts.map((part) => (part.type === "text" ? part.text : "")),
        ),
        ["tiny 2", "tiny 3"],
      );
      assert.equal(window.loadedMessageCount, 2);
      assert.equal(window.loadedPartCount, 2);
      assert.equal(window.loadedDataBytes, returnedBytes);
      assert.ok(window.loadedDataBytes <= LIMITS.maxDataBytes);
      assert.equal(window.boundaryFound, true);
      assert.equal(window.prefixTruncated, true);
      assert.equal(window.truncated, false);
      await saveMessage(store, 4);
      await saveMessage(store, 5);
      const withFuture = await read();
      assert.deepEqual(withFuture, { ...window, session: await store.getSession(SESSION_ID) });
    });
  });
}

async function withStore(work: (store: SqliteSessionStore, db: DatabaseSync) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "lcode-window-budget-"));
  const store = createSqliteSessionStore({ dbPath: join(directory, "sessions.db") });
  const db = new DatabaseSync(store.getDatabasePath());
  try {
    await work(store, db);
  } finally {
    db.close();
    store.close();
    await rm(directory, { force: true, recursive: true });
  }
}

async function seedTranscript(store: SqliteSessionStore, count: number) {
  await store.createSession({
    id: SESSION_ID,
    projectID: "project-test" as ProjectId,
    slug: SESSION_ID,
    directory: tmpdir(),
    title: "Window budget test",
    version: "1",
  });
  for (let index = 0; index < count; index += 1) await saveMessage(store, index);
}

async function saveMessage(store: SqliteSessionStore, index: number) {
  const base = { id: messageID(index), sessionID: SESSION_ID, agent: "build" };
  await store.saveMessage(
    index % 2 === 0
      ? { ...base, role: "user", time: { created: index } }
      : {
          ...base,
          role: "assistant",
          time: { created: index, completed: index + 1 },
          parentID: messageID(index - 1),
          mode: "build",
          path: { cwd: tmpdir(), root: tmpdir() },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
  );
  await store.savePart({
    id: `part_${index}` as PartId,
    sessionID: SESSION_ID,
    messageID: messageID(index),
    type: "text",
    text: `tiny ${index}`,
  });
}
