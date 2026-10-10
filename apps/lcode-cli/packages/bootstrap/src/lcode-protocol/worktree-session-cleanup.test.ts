import assert from "node:assert/strict";
import test from "node:test";
import { cleanupWorktreeSessions } from "./worktree-session-cleanup.js";
import type { LCodeProtocolAgentServerContext } from "./server-types.js";

const params = {
  executionBindingId: "binding",
  originWorkspacePath: "/origin",
  workspacePath: "/tree",
};
function fixture(busy = false) {
  const calls: string[] = [];
  const sessions = new Map([
    [
      "root",
      {
        app: {
          close: async () => {
            calls.push("close");
          },
          runtime: { hasResidencyBlockingWork: () => busy },
        },
        eventStore: {
          deleteSession: async () => {
            calls.push("events");
          },
        },
      },
    ],
  ]);
  const context = {
    sessions,
    deps: {
      deleteSessionDiagnostics: async (ids: string[]) => {
        assert.deepEqual(ids, ["root"]);
        calls.push("diagnostics");
      },
      sessionStore: {
        worktreeCleanup: async (input: { sessionIds?: string[] }) => {
          calls.push(input.sessionIds ? "purge" : "query");
          return { sessionIds: input.sessionIds ?? ["root"] };
        },
        getSession: async () => ({ id: "root" }),
      },
    },
    v4Gateway: {
      disposeSession: () => {
        calls.push("dispose");
      },
      hasResidencyBlockingCommands: () => false,
    },
    v4Interactions: { hasPendingForSession: () => false },
  } as unknown as LCodeProtocolAgentServerContext;
  return { context, sessions, calls };
}
test("query does not hydrate; collect closes matching resident chats before physical removal", async () => {
  const f = fixture();
  await cleanupWorktreeSessions(f.context, params);
  assert.deepEqual(f.calls, ["query"]);
  await cleanupWorktreeSessions(f.context, { ...params, closeSessions: true });
  assert.deepEqual(f.calls, ["query", "query", "close", "dispose", "events"]);
  assert.equal(f.sessions.size, 0);
  await cleanupWorktreeSessions(f.context, { ...params, sessionIds: ["root"] });
  assert.deepEqual(f.calls.slice(-2), ["purge", "diagnostics"]);
});

test("diagnostic file failure is retryable after SQL purge; collection never deletes diagnostic files", async () => {
  const f = fixture();
  let attempts = 0;
  f.context.deps.deleteSessionDiagnostics = async (ids) => {
    assert.deepEqual(ids, ["root"]);
    if (++attempts === 1) throw new Error("diagnostic file busy");
  };
  await cleanupWorktreeSessions(f.context, { ...params, closeSessions: true });
  assert.equal(attempts, 0);
  await assert.rejects(
    cleanupWorktreeSessions(f.context, { ...params, sessionIds: ["root"] }),
    /diagnostic file busy/,
  );
  await cleanupWorktreeSessions(f.context, { ...params, sessionIds: ["root"] });
  assert.equal(attempts, 2);
  assert.equal(f.calls.filter((call) => call === "purge").length, 2);
});

test("SQL purge failure cannot delete session diagnostics", async () => {
  const f = fixture();
  f.context.deps.sessionStore!.worktreeCleanup = async (input) => {
    if (input.sessionIds) throw new Error("SQL purge failed");
    return { sessionIds: ["root"] };
  };
  await assert.rejects(
    cleanupWorktreeSessions(f.context, { ...params, sessionIds: ["root"] }),
    /SQL purge failed/,
  );
  assert.equal(f.calls.includes("diagnostics"), false);
});
test("busy resident and scope mismatch fail before closing or deleting any chat", async () => {
  const f = fixture(true);
  await assert.rejects(
    cleanupWorktreeSessions(f.context, { ...params, closeSessions: true }),
    /running/,
  );
  assert.deepEqual(f.calls, ["query"]);
  const g = fixture();
  await assert.rejects(
    cleanupWorktreeSessions(g.context, { ...params, sessionIds: ["root", "other"] }),
    /scope/,
  );
  assert.deepEqual(g.calls, ["query"]);
  await assert.rejects(
    cleanupWorktreeSessions(g.context, { ...params, untrusted: true }),
    /Invalid params/,
  );
});
