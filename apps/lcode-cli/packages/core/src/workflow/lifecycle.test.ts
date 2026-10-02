import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowGraphSeed, WorkflowRunSnapshot } from "@lcode/contracts";
import {
  applyWorkflowGraphSeed,
  applyWorkflowNodePromptUpdates,
  cancelWorkflowSnapshot,
  reconcileWorkflowSnapshotForResume,
  reopenWorkflowGraphNode,
} from "./lifecycle.js";

function snapshot(): WorkflowRunSnapshot {
  return {
    runId: "workflow-test",
    status: "running",
    updatedAt: "before",
    phases: [{ phase: "build", status: "active" }],
    activities: [],
    sessionLinks: [],
    graph: {
      nodes: [
        { id: "a", title: "A", kind: "task", dependsOn: [], phase: "build", status: "active" },
      ],
      edges: [],
      collections: [],
    },
  } as unknown as WorkflowRunSnapshot;
}

test("graph seed preserves old nodes and rejects duplicate, cyclic and unknown edges", () => {
  const original = snapshot();
  const result = applyWorkflowGraphSeed(
    original,
    {
      nodes: [{ id: "b", title: "B", dependsOn: ["a"] }],
      edges: [],
      collections: [],
    } as unknown as WorkflowGraphSeed,
    { phase: "build", timestamp: "after" },
  );
  assert.equal(original.graph.nodes.length, 1);
  assert.equal(result.snapshot.graph.nodes[0], original.graph.nodes[0]);
  assert.deepEqual(result.addedEdges, [{ from: "a", to: "b" }]);
  assert.equal(result.addedNodes[0]?.phase, "build");
  assert.equal(result.addedNodes[0]?.status, "pending");
  for (const [seed, error] of [
    [{ nodes: [{ id: "a", title: "duplicate" }], edges: [], collections: [] }, /duplicate node/],
    [{ nodes: [], edges: [{ from: "b", to: "a" }], collections: [] }, /cycle/],
    [{ nodes: [], edges: [{ from: "missing", to: "a" }], collections: [] }, /unknown source/],
  ] as const) {
    assert.throws(
      () =>
        applyWorkflowGraphSeed(result.snapshot, seed as unknown as WorkflowGraphSeed, {
          timestamp: "later",
        }),
      error,
    );
  }
});

test("prompt updates remain phase-scoped and no-op updates retain snapshot identity", () => {
  const original = snapshot();
  const unchanged = applyWorkflowNodePromptUpdates(original, [{ id: "a", title: "A" }], {
    phase: "build",
    timestamp: "after",
  });
  assert.equal(unchanged.snapshot, original);
  assert.equal(unchanged.changed, false);
  assert.throws(
    () =>
      applyWorkflowNodePromptUpdates(original, [{ id: "a", prompt: "new prompt" }], {
        phase: "other",
        timestamp: "after",
      }),
    /targets phase/,
  );
  const updated = applyWorkflowNodePromptUpdates(original, [{ id: "a", prompt: "new prompt" }], {
    phase: "build",
    timestamp: "after",
  });
  assert.equal(updated.snapshot.graph.nodes[0]?.prompt, "new prompt");
  assert.equal(original.graph.nodes[0]?.prompt, undefined);
});

test("resume and cancel transitions stay immutable and reopen count is bounded", () => {
  const original = snapshot();
  const resumed = reconcileWorkflowSnapshotForResume(original, { timestamp: "resumed" });
  assert.equal(resumed.snapshot.graph.nodes[0]?.status, "pending");
  assert.equal(resumed.snapshot.phases[0]?.status, "pending");
  assert.equal(original.graph.nodes[0]?.status, "active");
  const cancelled = cancelWorkflowSnapshot(original, { timestamp: "cancelled" });
  assert.equal(cancelled.snapshot.status, "cancelled");
  assert.equal(cancelled.snapshot.graph.nodes[0]?.status, "cancelled");
  const completed = {
    ...original,
    graph: {
      ...original.graph,
      nodes: [{ ...original.graph.nodes[0]!, status: "completed" as const, reopenAttempts: 1 }],
    },
  };
  const reopened = reopenWorkflowGraphNode(completed, { nodeId: "a", timestamp: "reopened" });
  assert.equal(reopened.reopenAttempts, 2);
  assert.throws(
    () =>
      reopenWorkflowGraphNode(
        {
          ...completed,
          graph: {
            ...completed.graph,
            nodes: [{ ...completed.graph.nodes[0]!, reopenAttempts: 2 }],
          },
        },
        {
          nodeId: "a",
          timestamp: "reopened",
        },
      ),
    /max=2/,
  );
});
