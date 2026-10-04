import assert from "node:assert/strict";
import test from "node:test";
import type { CreateSessionInput, SessionId, ProjectId, MessageId, PartId } from "@lcode/contracts";
import { createSqliteSessionStore } from "../session-store.js";

test("worktree cleanup deletes shared/hidden chats and leaves independent or same-path remote chats", async () => {
  const store = createSqliteSessionStore({ dbPath: ":memory:" });
  const scope = {
    executionBindingId: "binding",
    originWorkspacePath: "/origin",
    workspacePath: "/tree",
  };
  try {
    for (const [id, binding, identity] of [
      ["root", "binding", undefined],
      ["fork", "binding", undefined],
      ["hidden", "binding", undefined],
      ["independent", "other", undefined],
      ["remote", "binding", "remote-other"],
    ] as const) {
      await store.createSession({
        id: id as SessionId,
        projectID: "project" as ProjectId,
        slug: id,
        title: id,
        directory: "/tree",
        path: "/tree",
        version: "test",
        workspaceID: identity as never,
        initialEntries: [
          {
            id: `binding-${id}`,
            sessionID: id as SessionId,
            type: "runtime/worktree_binding",
            time: { created: 1, updated: 1 },
            data: { ...scope, executionBindingId: binding, originWorkspaceIdentity: identity },
            touchSession: false,
          },
        ],
      } satisfies CreateSessionInput);
      await store.saveMessage({
        id: `message-${id}` as MessageId,
        sessionID: id as SessionId,
        role: "user",
        time: { created: 1 },
        agent: "agent",
      });
      await store.savePart({
        id: `part-${id}` as PartId,
        messageID: `message-${id}` as MessageId,
        sessionID: id as SessionId,
        type: "text",
        text: "private body",
      });
      await store.recordInputHistory({
        projectID: "project" as ProjectId,
        sessionID: id as SessionId,
        kind: "prompt",
        text: "private input",
      });
      await store.saveSessionInput({
        id: `input-${id}`,
        sessionID: id as SessionId,
        kind: "prompt",
        delivery: "queue",
        payload: { text: "private queued input" },
      });
    }
    assert.deepEqual((await store.worktreeCleanup(scope)).sessionIds.sort(), [
      "fork",
      "hidden",
      "root",
    ]);
    await assert.rejects(
      store.worktreeCleanup({ ...scope, sessionIds: ["root", "independent"] }),
      /scope/,
    );
    assert.ok(await store.getSession("root" as SessionId));
    const ids = ["root", "fork", "hidden"];
    await store.worktreeCleanup({ ...scope, sessionIds: ids });
    await store.worktreeCleanup({ ...scope, sessionIds: ids });
    for (const id of ids) {
      assert.equal(await store.getSession(id as SessionId), null);
      const counts = store.debugCounts(id as SessionId);
      for (const key of ["messages", "parts", "sessionEntries", "inputHistory"] as const)
        assert.equal(counts[key], 0, key);
      assert.deepEqual(await store.listSessionInputs({ sessionID: id as SessionId }), []);
    }
    assert.ok(await store.getSession("independent" as SessionId));
    assert.ok(await store.getSession("remote" as SessionId));
    assert.equal(store.debugCounts("independent" as SessionId).messages, 1);
    assert.equal(store.debugCounts("remote" as SessionId).parts, 1);
  } finally {
    store.close();
  }
});
