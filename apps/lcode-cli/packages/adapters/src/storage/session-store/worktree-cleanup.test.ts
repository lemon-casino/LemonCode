import assert from "node:assert/strict";
import test from "node:test";
import type { CreateSessionInput, SessionId, ProjectId, MessageId, PartId } from "@lcode/contracts";
import { createSqliteSessionStore } from "../session-store.js";
import type { SqliteStoreAccess } from "./store-access.js";

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

test("cleanup collects scoped descendants and recovers orphan children from the original journal without crossing identities or bindings", async () => {
  const store = createSqliteSessionStore({ dbPath: ":memory:" });
  const scope = {
    executionBindingId: "binding",
    originWorkspacePath: "/origin",
    workspacePath: "/tree",
  };
  const create = async (
    id: string,
    parent?: string,
    directory = "/tree",
    identity?: string,
    binding?: string,
  ) => {
    await store.createSession({
      id: id as SessionId,
      parentID: parent as SessionId,
      projectID: "project" as ProjectId,
      slug: id,
      title: id,
      directory,
      path: directory,
      version: "test",
      workspaceID: identity as never,
      initialEntries: binding
        ? [
            {
              id: `binding-${id}`,
              sessionID: id as SessionId,
              type: "runtime/worktree_binding",
              time: { created: 1, updated: 1 },
              data: { ...scope, executionBindingId: binding },
              touchSession: false,
            },
          ]
        : undefined,
    });
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
  };
  try {
    await create("root", undefined, "/tree", undefined, "binding");
    await create("child", "root");
    await create("grandchild", "child");
    await create("foreign-identity", "root", "/tree", "remote-other");
    await create("foreign-binding", "root", "/tree", undefined, "other");
    await create("independent-tree", "root", "/other");
    await create("unrelated");
    assert.deepEqual((await store.worktreeCleanup(scope)).sessionIds, [
      "child",
      "grandchild",
      "root",
    ]);
    await assert.rejects(store.worktreeCleanup({ ...scope, sessionIds: ["root"] }), /recollect/);
    assert.ok(
      await store.getSession("root" as SessionId),
      "完整子会话集合必须先持久化，不能先删除主会话",
    );
    // 模拟旧版只删除主会话行、没有清理 parent_id 后代的真实历史状态。
    (store as unknown as SqliteStoreAccess).db
      .prepare("delete from session where id = ?")
      .run("root");
    assert.deepEqual(
      (await store.worktreeCleanup({ ...scope, seedSessionIds: ["root"] })).sessionIds,
      ["child", "grandchild"],
    );
    await assert.rejects(
      store.worktreeCleanup({ ...scope, seedSessionIds: ["foreign-binding"] }),
      /scope/,
    );
    await store.worktreeCleanup({ ...scope, sessionIds: ["root", "child", "grandchild"] });
    for (const id of ["child", "grandchild"]) {
      assert.equal(await store.getSession(id as SessionId), null);
      assert.equal(store.debugCounts(id as SessionId).parts, 0);
    }
    for (const id of ["foreign-identity", "foreign-binding", "independent-tree", "unrelated"])
      assert.ok(await store.getSession(id as SessionId));
  } finally {
    store.close();
  }
});
