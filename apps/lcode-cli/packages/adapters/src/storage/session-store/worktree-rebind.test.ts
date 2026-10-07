import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectId, SessionId, WorkspaceId } from "@lcode/contracts";
import type { LCodeSessionWorktreeRebindParams, LCodeWorkspaceRef } from "@lcode/shared";
import { createSqliteSessionStore } from "../session-store.js";

const oldEnvironmentRef = { environmentId: "a".repeat(32), revision: 1, manifestDigest: "old" };
const newEnvironmentRef = { environmentId: "b".repeat(32), revision: 2, manifestDigest: "new" };
const params: LCodeSessionWorktreeRebindParams = {
  executionBindingId: "binding",
  originWorkspacePath: "/origin",
  workspacePath: "/tree",
  oldEnvironmentRef,
  newEnvironmentRef,
};
const reference: LCodeWorkspaceRef = {
  executionBindingId: params.executionBindingId,
  originWorkspacePath: params.originWorkspacePath,
  workspacePath: params.workspacePath,
  workspaceKey: params.workspacePath,
  environmentRef: oldEnvironmentRef,
};
type Store = ReturnType<typeof createSqliteSessionStore>;
async function add(store: Store, id: string, extra: Partial<LCodeWorkspaceRef> = {}) {
  const data = { ...reference, ...extra };
  await store.createSession({
    id: id as SessionId,
    projectID: "project" as ProjectId,
    slug: id,
    title: id,
    directory: data.workspacePath,
    path: data.workspacePath,
    workspaceID: data.workspaceIdentity as WorkspaceId | undefined,
    taskType: id === "hidden" ? "subagent_child" : id === "fork" ? "fork" : "interactive",
    ...(id === "fork" ? { parentID: "root" as SessionId } : {}),
    version: "test",
    initialEntries: [
      {
        id: `binding-${id}`,
        sessionID: id as SessionId,
        type: "runtime/worktree_binding",
        time: { created: 1, updated: 1 },
        data,
        touchSession: false,
      },
    ],
  });
}
async function latest(store: Store, id: string) {
  return (
    await store.sessionEntries({ sessionID: id as SessionId, type: "runtime/worktree_binding" })
  ).at(-1)?.data;
}
async function rebind(store: Store, input = params) {
  const { sessionIds } = await store.worktreeRebind(input);
  return store.worktreeRebind({ ...input, expectedSessionIds: sessionIds });
}

test("SQLite rebind migrates all latest archived/hidden/fork bindings and is idempotent", async () => {
  const store = createSqliteSessionStore({ dbPath: ":memory:" });
  try {
    await add(store, "root");
    await add(store, "fork", { bindingOwnerTaskId: "root" });
    await add(store, "hidden");
    await add(store, "archived");
    await store.updateSession({ id: "archived" as SessionId, timeArchived: 2 });
    await add(store, "already-new", { environmentRef: newEnvironmentRef });
    await add(store, "other-binding", { executionBindingId: "other" });
    await add(store, "other-remote", {
      originWorkspaceIdentity: "remote-origin",
      workspaceIdentity: "remote-tree",
      workspaceKey: "remote-tree",
      remoteSessionId: "remote-session",
    });
    await store.saveSessionEntry({
      id: "root-latest",
      sessionID: "root" as SessionId,
      type: "runtime/worktree_binding",
      time: { created: 1, updated: 2 },
      data: reference,
      touchSession: false,
    });
    const before = await store.getSession("fork" as SessionId);
    const expected = ["already-new", "archived", "fork", "hidden", "root"];
    assert.deepEqual(await store.worktreeRebind(params), { sessionIds: expected });
    assert.deepEqual(await latest(store, "root"), reference, "query is read-only");
    assert.deepEqual(await rebind(store), { sessionIds: expected });
    assert.deepEqual(await rebind(store), { sessionIds: expected });
    for (const id of expected)
      assert.deepEqual(
        ((await latest(store, id)) as LCodeWorkspaceRef).environmentRef,
        newEnvironmentRef,
      );
    assert.equal(((await latest(store, "fork")) as LCodeWorkspaceRef).bindingOwnerTaskId, "root");
    assert.deepEqual(await store.getSession("fork" as SessionId), before);
    const entries = await store.sessionEntries({
      sessionID: "root" as SessionId,
      type: "runtime/worktree_binding",
    });
    assert.ok(entries[0]);
    assert.deepEqual(
      (entries[0].data as LCodeWorkspaceRef).environmentRef,
      oldEnvironmentRef,
      "history is unchanged",
    );
    assert.deepEqual(
      ((await latest(store, "other-binding")) as LCodeWorkspaceRef).environmentRef,
      oldEnvironmentRef,
    );
    assert.deepEqual(
      ((await latest(store, "other-remote")) as LCodeWorkspaceRef).environmentRef,
      oldEnvironmentRef,
    );
  } finally {
    store.close();
  }
});

for (const badRef of [
  undefined,
  { ...oldEnvironmentRef, revision: 9 },
  { ...oldEnvironmentRef, manifestDigest: "wrong" },
]) {
  test(`SQLite rejects missing/stale references without partially migrating (${JSON.stringify(badRef)})`, async () => {
    const store = createSqliteSessionStore({ dbPath: ":memory:" });
    try {
      await add(store, "a-good");
      await add(store, "z-bad", { environmentRef: badRef });
      await assert.rejects(
        store.worktreeRebind({ ...params, expectedSessionIds: ["a-good", "z-bad"] }),
        /reference/,
      );
      assert.deepEqual(
        ((await latest(store, "a-good")) as LCodeWorkspaceRef).environmentRef,
        oldEnvironmentRef,
      );
    } finally {
      store.close();
    }
  });
}

test("SQLite rebind enforces both identities, session row scope and the preclosed complete set", async () => {
  const store = createSqliteSessionStore({ dbPath: ":memory:" });
  try {
    await add(store, "root");
    for (const wrongScope of [
      { originWorkspaceIdentity: "wrong" },
      { workspaceIdentity: "wrong" },
    ]) {
      assert.deepEqual(await rebind(store, { ...params, ...wrongScope }), { sessionIds: [] });
    }
    await assert.rejects(store.worktreeRebind({ ...params, expectedSessionIds: [] }), /changed/);
    const result = await store.worktreeRebind(params);
    await add(store, "new-session");
    await assert.rejects(
      store.worktreeRebind({ ...params, expectedSessionIds: result.sessionIds }),
      /changed/,
    );
    await store.updateSession({ id: "root" as SessionId, directory: "/wrong" });
    await assert.rejects(
      store.worktreeRebind({ ...params, expectedSessionIds: ["new-session", "root"] }),
      /scope/,
    );
    assert.deepEqual(
      ((await latest(store, "new-session")) as LCodeWorkspaceRef).environmentRef,
      oldEnvironmentRef,
    );
  } finally {
    store.close();
  }
});

test("SQLite rolls back writes already made when a later row update fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lcode-rebind-"));
  const dbPath = join(directory, "sessions.db");
  const store = createSqliteSessionStore({ dbPath });
  const observer = new DatabaseSync(dbPath);
  try {
    await add(store, "a-good");
    await add(store, "z-fail");
    observer.exec(`CREATE TRIGGER fail_rebind BEFORE UPDATE ON session_entry
      WHEN OLD.session_id = 'z-fail' BEGIN SELECT RAISE(ABORT, 'injected rebind failure'); END`);
    await assert.rejects(rebind(store), /injected rebind failure/);
    assert.deepEqual(
      ((await latest(store, "a-good")) as LCodeWorkspaceRef).environmentRef,
      oldEnvironmentRef,
    );
    observer.exec("DROP TRIGGER fail_rebind");
    assert.deepEqual(await rebind(store), { sessionIds: ["a-good", "z-fail"] });
  } finally {
    observer.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
