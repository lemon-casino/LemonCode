import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  goalAcceptanceSchema,
  goalAcceptanceHash,
  type SessionId,
  type ProjectId,
} from "@lcode/contracts";
import { createSqliteSessionStore } from "../session-store.js";
import { updateSessionTargetStatus } from "../session-target.js";

test("SQLite completion applies its expected predicate even if another connection replaces the row after pre-read", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "lcode-goal-cas-"));
  const path = join(directory, "session.db");
  const store = createSqliteSessionStore({ dbPath: path });
  const writer = new DatabaseSync(path);
  const concurrent = new DatabaseSync(path);
  try {
    const sessionID = "goal-cas" as SessionId;
    await store.createSession({
      id: sessionID,
      projectID: "project" as ProjectId,
      slug: "goal",
      directory,
      title: "goal",
      version: "1",
    });
    const acceptance = goalAcceptanceSchema.parse({
      policy: "strict",
      requirements: [
        {
          id: "gate",
          description: "check",
          source: "Bash",
          command: "node check.mjs",
          inputPaths: ["check.mjs"],
        },
      ],
    });
    const goal = await store.setTarget({ sessionID, objective: "original", acceptance });
    const prepare = writer.prepare.bind(writer);
    let replaced = false;
    t.mock.method(writer, "prepare", (sql: string) => {
      if (!replaced && /update session_target/u.test(sql)) {
        replaced = true;
        concurrent
          .prepare(
            "update session_target set target_id = 'replacement', objective = 'replacement', state_revision = state_revision + 1 where session_id = ?",
          )
          .run(sessionID);
      }
      return prepare(sql);
    });
    assert.equal(
      updateSessionTargetStatus(writer, {
        sessionID,
        status: "complete",
        expected: {
          targetID: goal.targetID,
          updatedAt: goal.time.updated,
          stateRevision: goal.stateRevision,
          acceptanceHash: goalAcceptanceHash(acceptance),
        },
      }),
      null,
    );
    const current = await store.readTarget({ sessionID });
    assert.equal(current?.targetID, "replacement");
    assert.equal(current?.status, "active");
  } finally {
    writer.close();
    concurrent.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("business status changes through metering and recovery advance revision while ordinary metering does not", async () => {
  const store = createSqliteSessionStore({ dbPath: ":memory:" });
  const sessionID = "goal-revisions" as SessionId;
  try {
    await store.createSession({
      id: sessionID,
      projectID: "project" as ProjectId,
      slug: "goal",
      directory: "fixture",
      title: "goal",
      version: "1",
    });
    const goal = await store.setTarget({ sessionID, objective: "task", tokenBudget: 10 });
    await store.accountTargetUsage({ sessionID, targetID: goal.targetID, tokensUsedDelta: 5 });
    assert.equal((await store.readTarget({ sessionID }))?.stateRevision, 0);
    await store.accountTargetUsage({ sessionID, targetID: goal.targetID, tokensUsedDelta: 5 });
    assert.equal((await store.readTarget({ sessionID }))?.stateRevision, 1);
    await store.updateTargetStatus({ sessionID, status: "active" });
    await store.startTargetRun({
      sessionID,
      targetID: goal.targetID,
      inputID: "first",
      startedAtMs: 1000,
    });
    await store.finishTargetRun({
      sessionID,
      targetID: goal.targetID,
      inputID: "first",
      endedAtMs: 2000,
      status: "paused",
    });
    assert.equal((await store.readTarget({ sessionID }))?.stateRevision, 3);
    await store.updateTargetStatus({ sessionID, status: "active" });
    await store.startTargetRun({
      sessionID,
      targetID: goal.targetID,
      inputID: "second",
      startedAtMs: 3000,
    });
    await store.recoverInterruptedTargetRun({ sessionID });
    assert.equal((await store.readTarget({ sessionID }))?.stateRevision, 5);
  } finally {
    store.close();
  }
});
