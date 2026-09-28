import assert from "node:assert/strict";
import test from "node:test";
import { reduceWorkflowRunsState } from "./workflow-runs-reducer.js";
import { WORKFLOW_RUNS_LIMITS, type WorkflowRunsState } from "./workflow-runs.js";

test("a new active node remains visible when the run node window fills", () => {
  const nodes = Array.from({ length: WORKFLOW_RUNS_LIMITS.maxNodes }, (_, index) => ({
    siteId: `ask#${index}`,
    ordinal: 1,
    phase: index === 1 ? ("executing" as const) : ("settled" as const),
    ...(index === 0 ? { actorSiteId: "actor#old", actorOrdinal: 1 } : {}),
    ...(index === 1 ? {} : { outcome: "ok" as const }),
  }));
  const previous: WorkflowRunsState = {
    revision: 1,
    runs: [
      {
        runId: "large",
        status: "running",
        usage: { spentTokens: 0, nodesUsed: 0 },
        actors: [{ siteId: "actor#old", ordinal: 1, status: "completed" }],
        nodes,
        lastEventSequence: 1,
      },
    ],
  };
  const next = reduceWorkflowRunsState(previous, {
    runId: "large",
    sequence: 2,
    eventType: "node-queued",
    payload: { instance: { siteId: "ask#new", ordinal: 1 }, kind: "ask" },
  })?.runs[0];
  assert.ok(next);
  assert.equal(next.nodes.length, WORKFLOW_RUNS_LIMITS.maxNodes);
  assert.equal(
    next.nodes.some((node) => node.siteId === "ask#new" && node.phase === "queued"),
    true,
  );
  assert.equal(
    next.nodes.some((node) => node.siteId === "ask#1" && node.phase === "executing"),
    true,
  );
  assert.equal(next.actors[0]?.status, "completed");
  assert.equal(next.truncated, true);
  const settled = reduceWorkflowRunsState(
    { revision: 2, runs: [next] },
    {
      runId: "large",
      sequence: 3,
      eventType: "node-settled",
      payload: { instance: { siteId: "ask#new", ordinal: 1 }, outcome: "ok" },
    },
  )?.runs[0];
  assert.equal(settled?.nodes.find((node) => node.siteId === "ask#new")?.phase, "settled");
});
