import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import type { MessageId, ProjectId, SessionId } from "@lcode/contracts";
import { createSqliteSessionStore } from "../session-store.js";

test("cut proof follows the exact window ordering and never accepts missing or foreign anchors", async () => {
  const root = await mkdtemp(join(tmpdir(), "lcode-window-proof-"));
  const dbPath = join(root, "session.db");
  const store = createSqliteSessionStore({ dbPath });
  const db = new DatabaseSync(dbPath);
  const sessionID = "sess_branch_proof" as SessionId;
  const messageID = (i: number) => `msg_${10 - i}` as MessageId;
  try {
    const metadata = {
      projectID: "proj_proof" as ProjectId,
      slug: "fixture",
      version: "1",
      directory: root,
      title: "Fixture",
    };
    await store.createSession({ ...metadata, id: sessionID });
    for (let i = 0; i < 8; i++)
      await store.saveMessage({
        id: messageID(i),
        sessionID,
        role: "user",
        agent: "build",
        time: { created: i },
      });
    const read = () =>
      store.readTranscriptWindow({
        sessionID,
        throughMessageID: messageID(7),
        limits: { maxMessageRows: 2, maxPartRows: 10, maxDataBytes: 10_000 },
      });
    for (const [cut, expected] of [
      [messageID(0), true],
      [messageID(5), true],
      [messageID(6), false],
      [messageID(7), false],
      ["absent", false],
    ] as const) {
      await store.setRevert({
        sessionID,
        revert: {
          messageID: messageID(0),
          targetMessageID: messageID(0),
          branchCutAfterMessageID: cut as MessageId,
          branchGeneration: 4,
        },
      });
      const window = await read();
      assert.deepEqual(
        window.branchCutBeforeWindow,
        expected ? { messageID: cut, branchGeneration: 4 } : undefined,
      );
    }
    await store.createSession({ ...metadata, id: "sess_foreign" as SessionId });
    await store.saveMessage({
      id: "foreign" as MessageId,
      sessionID: "sess_foreign" as SessionId,
      role: "user",
      agent: "build",
      time: { created: 0 },
    });
    await store.setRevert({
      sessionID,
      revert: {
        messageID: messageID(0),
        targetMessageID: messageID(0),
        branchCutAfterMessageID: "foreign" as MessageId,
      },
    });
    assert.equal((await read()).branchCutBeforeWindow, undefined);
    // NULL sequence按time/rowid排序，不能按ID或创建时间独自推断cut早于窗口。
    db.exec(
      "update message set sequence = null, time_created = 1 where session_id = 'sess_branch_proof'",
    );
    await store.setRevert({
      sessionID,
      revert: {
        messageID: messageID(0),
        targetMessageID: messageID(0),
        branchCutAfterMessageID: messageID(5),
        branchGeneration: 5,
      },
    });
    assert.deepEqual((await read()).branchCutBeforeWindow, {
      messageID: messageID(5),
      branchGeneration: 5,
    });
    db.prepare("update message set time_created = 2 where id = ?").run(messageID(5));
    assert.equal(
      (await read()).branchCutBeforeWindow,
      undefined,
      "cut ordered after boundary cannot prove the suffix",
    );
    await store.removeMessage({ sessionID, messageID: messageID(5) });
    assert.equal((await read()).branchCutBeforeWindow, undefined);
  } finally {
    db.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a before-window proof and branch generation remain in the same snapshot during concurrent deletion", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lcode-window-proof-race-"));
  const dbPath = join(root, "session.db");
  const store = createSqliteSessionStore({ dbPath });
  const db = new DatabaseSync(dbPath);
  const sessionID = "sess_proof_race" as SessionId;
  const cut = "msg_cut" as MessageId;
  const boundary = "msg_end" as MessageId;
  try {
    await store.createSession({
      id: sessionID,
      projectID: "proj_race" as ProjectId,
      slug: "fixture",
      version: "1",
      directory: root,
      title: "Fixture",
    });
    for (const [i, id] of [cut, "msg_middle" as MessageId, boundary].entries()) {
      await store.saveMessage({
        id,
        sessionID,
        role: "user",
        agent: "build",
        time: { created: i },
      });
    }
    const revert = {
      messageID: cut,
      targetMessageID: cut,
      branchCutAfterMessageID: cut,
      branchGeneration: 1,
    };
    await store.setRevert({ sessionID, revert });
    const prepare = DatabaseSync.prototype.prepare;
    let changed = false;
    t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
      const statement = prepare.call(this, sql);
      if (this === db || !/select \* from session where id = \?/iu.test(sql)) return statement;
      const get = statement.get.bind(statement);
      t.mock.method(statement, "get", (...args: SQLInputValue[]) => {
        const row = get(...args);
        if (!changed) {
          changed = true;
          db.exec("begin immediate");
          db.prepare("update session set revert = ? where id = ?").run(
            JSON.stringify({ ...revert, branchGeneration: 2 }),
            sessionID,
          );
          db.prepare("delete from message where id = ?").run(cut);
          db.exec("commit");
        }
        return row;
      });
      return statement;
    });
    const read = () =>
      store.readTranscriptWindow({
        sessionID,
        throughMessageID: boundary,
        limits: { maxMessageRows: 1, maxPartRows: 10, maxDataBytes: 10_000 },
      });
    const frozen = await read();
    assert.deepEqual(frozen.session?.revert, revert);
    assert.deepEqual(frozen.branchCutBeforeWindow, { messageID: cut, branchGeneration: 1 });
    const current = await read();
    assert.equal(current.session?.revert?.branchGeneration, 2);
    assert.equal(current.branchCutBeforeWindow, undefined);
  } finally {
    db.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
