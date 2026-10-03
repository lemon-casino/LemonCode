import assert from "node:assert/strict";
import test from "node:test";
import type { CommandEnvelope } from "@lcode/shared/lcode-protocol-v4";
import { pendingCommandRegistry } from "./pendingCommandRegistry.js";
import { isPendingCommandForWorkspace } from "./pendingCommandWorkspace.js";

test("fork recovery keeps a scoped query hint without replaying a new child creation", () => {
  const envelope: CommandEnvelope = {
    commandId: "fork-recovery",
    clientId: "fixture",
    sessionId: "parent",
    issuedAt: Date.now(),
    type: "forkSession",
    payload: { workspaceMode: "worktree" },
    baseRevision: 7,
  };
  const key = { commandId: envelope.commandId, sessionId: envelope.sessionId };
  try {
    pendingCommandRegistry.record(envelope, {
      workspace: { workspacePath: "/same", workspaceIdentity: "host-a" },
    });
    const entry = pendingCommandRegistry.list("parent")[0]!;
    assert.equal(entry.replay.kind, "sensitiveDigest");
    assert.equal(isPendingCommandForWorkspace(entry, "/same", "host-a"), true);
    assert.equal(isPendingCommandForWorkspace(entry, "/same", "host-b"), false);
    assert.equal(pendingCommandRegistry.consumeReplay(key), null);
    pendingCommandRegistry.applyQuery({
      results: [
        {
          key,
          result: {
            commandId: key.commandId,
            status: "failed",
            revisionAtDecision: 7,
            reasonCode: "fault.command.queryUnavailable",
          },
        },
      ],
    });
    assert.equal(pendingCommandRegistry.list("parent").length, 1);
    pendingCommandRegistry.applyQuery({
      results: [
        {
          key,
          result: {
            commandId: key.commandId,
            status: "accepted",
            revisionAtDecision: 7,
            result: { type: "forkSession", sessionId: "child", workspacePath: "/tree" },
          },
        },
      ],
    });
    assert.equal(pendingCommandRegistry.list("parent").length, 0);
  } finally {
    pendingCommandRegistry.settle(key.sessionId, key.commandId);
  }
});
