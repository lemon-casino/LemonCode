import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  SESSION_TRANSCRIPT_SNAPSHOT_MAX_DATA_BYTES,
  SESSION_TRANSCRIPT_SNAPSHOT_MAX_MESSAGE_ROWS,
  SESSION_TRANSCRIPT_SNAPSHOT_MAX_PART_ROWS,
  type MessageId,
  type PartId,
  type ProjectId,
  type SessionId,
} from "@lcode/contracts";
import { createSqliteSessionStore, type SqliteSessionStore } from "../session-store.js";

test("BTS-1/2 SQLite snapshot enforces deterministic message and part prefixes", async () => {
  await withStore(async (store) => {
    const sessionID = await seedTranscript(store, 3);
    const messageBounded = await store.readTranscriptSnapshot({
      sessionID,
      limits: {
        maxDataBytes: SESSION_TRANSCRIPT_SNAPSHOT_MAX_DATA_BYTES,
        maxMessageRows: 2,
        maxPartRows: SESSION_TRANSCRIPT_SNAPSHOT_MAX_PART_ROWS,
      },
    });

    assert.deepEqual(
      messageBounded.messages.map((message) => message.info.id),
      ["msg_0", "msg_1"],
    );
    assert.equal(messageBounded.loadedMessageCount, 2);
    assert.equal(messageBounded.loadedPartCount, 2);
    assert.equal(messageBounded.truncated, true);

    const partBounded = await store.readTranscriptSnapshot({
      sessionID,
      limits: {
        maxDataBytes: SESSION_TRANSCRIPT_SNAPSHOT_MAX_DATA_BYTES,
        maxMessageRows: SESSION_TRANSCRIPT_SNAPSHOT_MAX_MESSAGE_ROWS,
        maxPartRows: 2,
      },
    });
    assert.equal(partBounded.loadedMessageCount, 3);
    assert.equal(partBounded.loadedPartCount, 2);
    assert.deepEqual(
      partBounded.messages.flatMap((message) => message.parts.map((part) => part.id)),
      ["part_0", "part_1"],
    );
    assert.equal(partBounded.truncated, true);
  });
});

test("BTS-3 SQLite snapshot stops before a JSON row exceeds the combined byte budget", async () => {
  await withStore(async (store) => {
    const sessionID = "sess_bytes" as SessionId;
    await createSession(store, sessionID);
    await saveUserMessage(store, sessionID, 0, "needle ".repeat(1_000));

    const snapshot = await store.readTranscriptSnapshot({
      sessionID,
      limits: { maxDataBytes: 512, maxMessageRows: 10, maxPartRows: 10 },
    });

    assert.equal(snapshot.loadedMessageCount, 1);
    assert.equal(snapshot.loadedPartCount, 0);
    assert.ok(snapshot.loadedDataBytes <= 512);
    assert.equal(snapshot.truncated, true);
  });
});

test("BTS-5 missing sessions return an empty non-truncated snapshot", async () => {
  await withStore(async (store) => {
    const snapshot = await store.readTranscriptSnapshot({
      sessionID: "sess_missing" as SessionId,
      limits: { maxDataBytes: 1, maxMessageRows: 1, maxPartRows: 1 },
    });
    assert.deepEqual(snapshot, {
      session: null,
      messages: [],
      loadedMessageCount: 0,
      loadedPartCount: 0,
      loadedDataBytes: 0,
      truncated: false,
    });
  });
});

async function withStore(work: (store: SqliteSessionStore) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "lcode-transcript-snapshot-"));
  const store = createSqliteSessionStore({ dbPath: join(directory, "sessions.db") });
  try {
    await work(store);
  } finally {
    store.close();
    await rm(directory, { force: true, recursive: true });
  }
}

async function seedTranscript(store: SqliteSessionStore, count: number): Promise<SessionId> {
  const sessionID = "sess_bounded" as SessionId;
  await createSession(store, sessionID);
  for (let index = 0; index < count; index += 1) {
    await saveUserMessage(store, sessionID, index, `message ${index}`);
  }
  return sessionID;
}

async function createSession(store: SqliteSessionStore, sessionID: SessionId): Promise<void> {
  await store.createSession({
    id: sessionID,
    projectID: "project-test" as ProjectId,
    slug: String(sessionID),
    directory: "C:\\workspace\\test",
    title: "Snapshot test",
    version: "1",
  });
}

async function saveUserMessage(
  store: SqliteSessionStore,
  sessionID: SessionId,
  index: number,
  text: string,
): Promise<void> {
  const messageID = `msg_${index}` as MessageId;
  await store.saveMessage({
    agent: "build",
    id: messageID,
    role: "user",
    sessionID,
    time: { created: index + 1 },
  });
  await store.savePart({
    id: `part_${index}` as PartId,
    messageID,
    sessionID,
    text,
    type: "text",
  });
}
