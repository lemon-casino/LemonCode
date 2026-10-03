import assert from "node:assert/strict";
import test from "node:test";
import { createV4SessionIndexHost } from "./v4-bridge-session-index.js";
import type { LCodeProtocolAgentServerContext } from "./server-types.js";

test("cold index recovers actual worktree binding metadata while legacy local rows remain compatible", async () => {
  const context = {
    sessions: new Map(),
    deps: {
      sessionStore: {
        listSessions: async () => [
          { id: "bound", createdAt: 1, updatedAt: 2, title: "Bound" },
          { id: "local", createdAt: 1, updatedAt: 2, title: "Local" },
        ],
        sessionEntries: async ({ sessionID }: { sessionID: string }) =>
          sessionID === "bound"
            ? [
                {
                  data: {
                    workspacePath: "/tree",
                    workspaceKey: "/tree",
                    originWorkspacePath: "/origin",
                    executionBindingId: "binding",
                  },
                },
              ]
            : [],
      },
    },
  } as unknown as LCodeProtocolAgentServerContext;
  const host = createV4SessionIndexHost(context);
  const rows = await host.getStoredSessionSummaries!("/origin");
  assert.equal(rows[0]?.executionBindingId, "binding");
  assert.equal(rows[0]?.workspaceId, "/origin");
  assert.equal(rows[1]?.executionBindingId, undefined);
});
