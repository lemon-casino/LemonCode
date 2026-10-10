import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  goalAcceptanceHash,
  goalAcceptanceSchema,
  type SessionId,
  type ProjectId,
} from "@lcode/contracts";
import { createSqliteSessionStore } from "../session-store.js";

const id = "goal-session" as SessionId;
const acceptance = goalAcceptanceSchema.parse({
  policy: "strict",
  requirements: [
    {
      id: "gate",
      description: "check source",
      source: "Bash",
      command: "node test.mjs",
      inputPaths: ["source.ts"],
    },
  ],
});
async function seed(store: ReturnType<typeof createSqliteSessionStore>) {
  await store.createSession({
    id,
    projectID: "project" as ProjectId,
    slug: "goal",
    directory: "fixture",
    title: "goal",
    version: "1",
  });
}
test("strict acceptance survives reopen, pause/resume, and conditional completion; legacy remains compatible", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lcode-goal-acceptance-"));
  const path = join(directory, "session.db");
  let store = createSqliteSessionStore({ dbPath: path });
  try {
    await seed(store);
    await store.setTarget({ sessionID: id, objective: "task", acceptance });
    await assert.rejects(
      store.updateTargetStatus({ sessionID: id, status: "complete" }),
      /Strict completion requires/,
    );
    store.close();
    store = createSqliteSessionStore({ dbPath: path });
    let goal = (await store.readTarget({ sessionID: id }))!;
    assert.deepEqual(goal.acceptance, acceptance);
    await store.updateTargetStatus({ sessionID: id, status: "paused" });
    goal = (await store.updateTargetStatus({ sessionID: id, status: "active" }))!;
    await assert.rejects(store.updateTargetStatus({
      sessionID: id,
      status: "complete",
      expected: {
        targetID: goal.targetID,
        updatedAt: goal.time.updated,
        stateRevision: goal.stateRevision,
        acceptanceHash: goalAcceptanceHash(acceptance),
      },
    }), /Strict completion/);
    const legacy = await store.setTarget({ sessionID: id, objective: "legacy" });
    assert.equal(legacy.acceptance, undefined);
    assert.equal(
      (await store.updateTargetStatus({ sessionID: id, status: "complete" }))?.status,
      "complete",
    );
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test("monotonic revision rejects same-millisecond pause/resume and replacement; run-accounting cannot bypass strict commit", async (t) => {
  t.mock.method(Date, "now", () => 1000);
  const store = createSqliteSessionStore({ dbPath: ":memory:" });
  try {
    await seed(store);
    const first = await store.setTarget({ sessionID: id, objective: "task", acceptance });
    const expected = {
      targetID: first.targetID,
      updatedAt: first.time.updated,
      stateRevision: first.stateRevision,
      acceptanceHash: goalAcceptanceHash(acceptance),
    };
    await store.updateTargetStatus({ sessionID: id, status: "paused" });
    await store.updateTargetStatus({ sessionID: id, status: "active" });
    assert.equal(
      await store.updateTargetStatus({ sessionID: id, status: "complete", expected }),
      null,
    );
    const replacement = await store.setTarget({
      sessionID: id,
      objective: "replacement",
      acceptance,
    });
    assert.equal(
      await store.updateTargetStatus({ sessionID: id, status: "complete", expected }),
      null,
    );
    await store.startTargetRun({
      sessionID: id,
      targetID: replacement.targetID,
      inputID: "run",
      startedAtMs: 1000,
    });
    await assert.rejects(
      store.finishTargetRun({
        sessionID: id,
        targetID: replacement.targetID,
        inputID: "run",
        endedAtMs: 1001,
        status: "complete",
      }),
      /cannot bypass/,
    );
    await assert.rejects(
      store.setTarget({ sessionID: id, objective: "skip", acceptance, status: "complete" }),
      /cannot be created complete/,
    );
  } finally {
    store.close();
  }
});
