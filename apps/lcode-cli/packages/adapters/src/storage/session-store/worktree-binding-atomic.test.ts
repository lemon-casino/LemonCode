import assert from "node:assert/strict";
import test from "node:test";
import type { CreateSessionInput, SessionId, ProjectId } from "@lcode/contracts";
import { createSqliteSessionStore } from "../session-store.js";

const input: CreateSessionInput = {
  id: "worktree-task" as SessionId,
  projectID: "project" as ProjectId,
  slug: "task",
  directory: "/tree",
  path: "/tree",
  title: "task",
  version: "test",
};
const entry = {
  id: "binding-reference",
  sessionID: input.id,
  type: "runtime/worktree_binding",
  time: { created: 1, updated: 1 },
  data: { executionBindingId: "binding", workspacePath: "/tree" },
  touchSession: false,
};

test("session execution path and binding reference persist atomically", async () => {
  const store = createSqliteSessionStore({ dbPath: ":memory:" });
  try {
    await store.createSession({ ...input, initialEntries: [entry] });
    assert.equal((await store.getSession(input.id))?.path, "/tree");
    assert.deepEqual((await store.sessionEntries({ sessionID: input.id }))[0]?.data, entry.data);
  } finally {
    store.close();
  }
});

test("invalid binding entry rolls back the session row", async () => {
  const store = createSqliteSessionStore({ dbPath: ":memory:" });
  try {
    await assert.rejects(
      store.createSession({
        ...input,
        initialEntries: [{ ...entry, sessionID: "other" as SessionId }],
      }),
      /belong/,
    );
    assert.equal(await store.getSession(input.id), null);
  } finally {
    store.close();
  }
});

test("origin task lists include worktrees while isolating same-path remote identities", async () => {
  const store = createSqliteSessionStore({ dbPath: ":memory:" });
  try {
    for (const [id, identity] of [
      ["local", undefined],
      ["remote-a", "remote-a"],
      ["remote-b", "remote-b"],
    ] as const) {
      await store.createSession({
        ...input,
        id: id as SessionId,
        workspaceID: identity as never,
        initialEntries: [
          {
            ...entry,
            id: `binding-${id}`,
            sessionID: id as SessionId,
            data: {
              ...entry.data,
              originWorkspacePath: "/origin",
              ...(identity ? { originWorkspaceIdentity: identity } : {}),
            },
          },
        ],
      });
    }
    const local = await store.listSessions({
      directory: "/origin",
      workspaceID: null,
      includeWorktreeOrigins: true,
    });
    assert.deepEqual(
      local.map((row) => row.id),
      ["local"],
    );
    const remote = await store.listSessions({
      directory: "/origin",
      workspaceID: "remote-a" as never,
      includeWorktreeOrigins: true,
    });
    assert.deepEqual(
      remote.map((row) => row.id),
      ["remote-a"],
    );
    assert.deepEqual(await store.listSessions({ directory: "/origin", workspaceID: null }), []);
  } finally {
    store.close();
  }
});
