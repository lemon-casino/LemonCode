import assert from "node:assert/strict";
import test from "node:test";
import type {
  CreateSessionInput,
  ForkCommitBundle,
  MessageId,
  PartId,
  ProjectId,
  SessionId,
  SharedContextImportCommitBundle,
} from "@lcode/contracts";
import { createSqliteSessionStore, SqliteSessionStore } from "../session-store.js";
import type { ForkCommitFaultStage } from "./options.js";

const faultStages: ForkCommitFaultStage[] = [
  "afterChild",
  "afterMessages",
  "afterGoal",
  "afterEntries",
  "afterInput",
  "afterCommandFact",
  "beforeCommit",
];

for (const stage of faultStages) {
  test(`fork bundle rolls back all child state at ${stage}`, async () => {
    const store = createSqliteSessionStore({ dbPath: ":memory:", forkCommitFaultAt: stage });
    try {
      await store.createSession(sessionInput("parent"));
      const before = store.debugCounts();
      await assert.rejects(
        store.commitForkBundle(forkBundle()),
        new RegExp(`injected fork commit fault: ${stage}`),
      );
      assert.deepEqual(store.debugCounts(), before);
      assert.equal(await store.getSession("child" as SessionId), null);
      assert.deepEqual(await store.sessionEntries({ sessionID: "parent" as SessionId }), []);
    } finally {
      store.close();
    }
  });
}

test("fork bundle keeps child-local guards, idempotency and original prototype arity", async () => {
  const store = createSqliteSessionStore({ dbPath: ":memory:" });
  try {
    await store.createSession(sessionInput("parent"));
    const invalid = forkBundle();
    invalid.messages[0]!.parts[0]!.sessionID = "foreign" as SessionId;
    await assert.rejects(store.commitForkBundle(invalid), /part owner is not child-local/);
    assert.equal(await store.getSession("child" as SessionId), null);
    const valid = forkBundle();
    const child = await store.commitForkBundle(valid);
    const counts = store.debugCounts();
    assert.equal((await store.commitForkBundle(valid)).id, child.id);
    assert.deepEqual(store.debugCounts(), counts);
    assert.equal((await store.messages({ sessionID: child.id }))[0]?.parts[0]?.id, "part-child");
    assert.equal((await store.readTarget({ sessionID: child.id }))?.targetID, "goal-child");
    assert.equal((await store.listSessionInputs({ sessionID: child.id }))[0]?.status, "admitted");
    assert.equal(store.workflowJournalStore(), store.workflowJournalStore());
    for (const [method, arity] of [
      ["createForkedSessionWithMetadata", 2],
      ["commitForkBundle", 1],
      ["listSessions", 0],
      ["recordModelUsage", 1],
      ["setTarget", 1],
      ["pruneUsage", 1],
      ["listScriptWorkflowRuns", 1],
    ] as const) {
      const descriptor = Object.getOwnPropertyDescriptor(SqliteSessionStore.prototype, method);
      assert.equal(descriptor?.enumerable, false);
      assert.equal(descriptor?.value.length, arity);
      assert.equal(Object.hasOwn(store, method), false);
    }
  } finally {
    store.close();
  }
});

test("shared context import preserves atomic provenance and guarded transitions", async () => {
  const store = createSqliteSessionStore({ dbPath: ":memory:" });
  try {
    const input = sharedContextBundle();
    const invalid = { ...input, provenance: { ...input.provenance, id: "foreign-provenance" } };
    await assert.rejects(store.commitSharedContextImportBundle(invalid), /identity is invalid/);
    assert.equal(store.debugCounts().sessions, 0);
    await store.commitSharedContextImportBundle(input);
    const before = store.debugCounts();
    await store.commitSharedContextImportBundle(input);
    assert.deepEqual(store.debugCounts(), before);
    assert.equal(
      await store.transitionSharedContextImport({
        sessionID: input.session.id,
        contextId: "context",
        expectedStatus: "attached",
        status: "discarded",
      }),
      false,
    );
    assert.equal(
      await store.transitionSharedContextImport({
        sessionID: input.session.id,
        contextId: "context",
        expectedStatus: "pending",
        status: "reserved",
        sourceId: "input",
      }),
      true,
    );
    const messages = await store.messages({ sessionID: input.session.id });
    assert.deepEqual(messages[0]?.info.metadata, {
      contextId: "context",
      retained: true,
      sharedContextStatus: "reserved",
    });
    assert.equal(
      (await store.sessionEntries({ sessionID: input.session.id }))[0]?.data &&
        store.debugCounts().sessionEntries,
      1,
    );
  } finally {
    store.close();
  }
});

function sessionInput(id: string): CreateSessionInput {
  return {
    id: id as SessionId,
    projectID: "project" as ProjectId,
    slug: id,
    directory: "fixture-workspace",
    title: id,
    version: "1",
  };
}

function forkBundle(): ForkCommitBundle {
  const sessionID = "child" as SessionId;
  const messageID = "msg-child" as MessageId;
  return {
    child: { ...sessionInput("child"), parentID: "parent" as SessionId },
    messages: [
      {
        info: { id: messageID, sessionID, agent: "build", role: "user", time: { created: 1 } },
        parts: [
          { id: "part-child" as PartId, messageID, sessionID, type: "text", text: "fixture" },
        ],
      },
    ],
    entries: [
      {
        id: "entry-child",
        sessionID,
        type: "v4/fixture",
        time: { created: 1, updated: 1 },
        data: {},
      },
    ],
    goal: {
      source: {
        sessionID,
        targetID: "goal-child",
        objective: "fixture goal",
        summaryTitle: null,
        status: "active",
        tokenBudget: null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        time: { created: 1, updated: 1 },
      },
      status: "active",
    },
    initialInput: {
      id: "input-child",
      sessionID,
      kind: "prompt",
      delivery: "startNow",
      payload: { text: "fixture" },
    },
    commandFact: {
      parentSessionId: "parent",
      sourceCommandId: "command",
      ack: {
        commandId: "command",
        status: "accepted",
        revisionAtDecision: 0,
        result: { type: "forkAssistant", sessionId: "child" },
      },
      metadata: {},
    },
  };
}

function sharedContextBundle(): SharedContextImportCommitBundle {
  const sessionID = "shared-session" as SessionId;
  return {
    session: sessionInput(sessionID),
    contextMessage: {
      info: {
        id: "context-message" as MessageId,
        sessionID,
        role: "user",
        agent: "build",
        time: { created: 1 },
        visibility: "model-only",
        source: "shared_context",
        metadata: { contextId: "context", retained: true },
      },
      parts: [],
    },
    provenance: {
      id: "provenance-shared-session",
      sessionID,
      type: "v4/shared_context_import",
      time: { created: 1, updated: 1 },
      data: { contextId: "context", status: "pending" },
    },
  };
}
