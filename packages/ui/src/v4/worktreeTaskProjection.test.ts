import assert from "node:assert/strict";
import test from "node:test";
import type { SessionSummary } from "@lcode/shared/lcode-protocol-v4";
import { mapSessionSummaryToTaskMeta } from "./mapSessionSummaryToTaskMeta.js";
import { mergeTaskIndexRowsWithSessions } from "./buildTaskListResultFromSessions.js";

const summary: SessionSummary = {
  sessionId: "task",
  workspaceId: "origin",
  title: "Task",
  phase: "completedSuccess",
  sessionEnded: true,
  hasBackgroundWork: false,
  createdAt: 1,
  lastActivityAt: 2,
  executionBindingId: "binding",
  parentSessionId: "parent",
};
const scope = { workspacePath: "C:/project", workspaceIdentity: "origin" };

test("actual worktree metadata and fork lineage reach sidebar rows in the original project", () => {
  const session = mapSessionSummaryToTaskMeta(summary, scope);
  const stored = { ...session, executionBindingId: undefined, forkedFromTaskId: undefined };
  const [row] = mergeTaskIndexRowsWithSessions({ taskIndexItems: [stored], sessions: [session] });
  assert.equal(row?.executionBindingId, "binding");
  assert.equal(row?.forkedFromTaskId, "parent");
  assert.equal(row?.workspacePath, scope.workspacePath);
});

test("local summaries clear stale worktree markers; a different identity cannot update the row", () => {
  const stored = mapSessionSummaryToTaskMeta(summary, scope);
  const local = mapSessionSummaryToTaskMeta(
    { ...summary, executionBindingId: undefined },
    { ...scope, previous: stored },
  );
  assert.equal(
    mergeTaskIndexRowsWithSessions({ taskIndexItems: [stored], sessions: [local] })[0]
      ?.executionBindingId,
    undefined,
  );
  const other = mapSessionSummaryToTaskMeta(
    { ...summary, executionBindingId: "other-binding" },
    { ...scope, workspaceIdentity: "other" },
  );
  assert.equal(
    mergeTaskIndexRowsWithSessions({ taskIndexItems: [stored], sessions: [other] })[0],
    stored,
  );
});
