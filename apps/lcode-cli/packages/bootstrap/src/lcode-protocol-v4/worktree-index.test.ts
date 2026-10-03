import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationSnapshot } from "@lcode/shared/lcode-protocol-v4";
import { SessionsIndexProjection } from "./sessions-index-projection.js";

test("worktree binding changes produce an index delta without changing task membership", () => {
  const projection = new SessionsIndexProjection("origin", "epoch");
  const snapshot = {
    sessionId: "task",
    rows: { window: [] },
    meta: { title: "Task", titleSource: "generated" },
    control: { phase: "completedSuccess", sessionEnded: true },
    backgroundWorks: [],
    pendingInteractions: [],
    workflowRuns: [],
  } as unknown as ConversationSnapshot;
  const extra = { createdAt: 1, lastActivityAt: 2, executionBindingId: "binding" };
  const [first] = projection.upsertFromConversation(snapshot, extra);
  assert.equal(first?.op, "session.upserted");
  if (first?.op === "session.upserted") {
    assert.equal(first.session.workspaceId, "origin");
    assert.equal(first.session.executionBindingId, "binding");
  }
  assert.deepEqual(projection.upsertFromConversation(snapshot, extra), []);
  const [local] = projection.upsertFromConversation(snapshot, { createdAt: 1, lastActivityAt: 2 });
  assert.equal(local?.op, "session.upserted");
  if (local?.op === "session.upserted") assert.equal(local.session.executionBindingId, undefined);
});
