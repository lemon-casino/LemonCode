import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";
import { buildWorkflowTimeline } from "./timeline-model.js";

test("shared-site instances stay in their own phases while a large run advances", () => {
  const graph: WorkflowCausalityGraphData = {
    steps: [
      { id: "ask#1~A", source: "ask#1", kind: "ask", label: "draft", lane: "actor#1", phase: "A" },
      { id: "ask#1~B", source: "ask#1", kind: "ask", label: "revise", lane: "actor#1", phase: "B" },
    ],
    lanes: [{ id: "actor#1", name: "writer" }],
    participants: [
      { id: "writer-A", phase: "A", lane: "actor#1", steps: ["ask#1~A"] },
      { id: "writer-B", phase: "B", lane: "actor#1", steps: ["ask#1~B"] },
    ],
    handoffs: [],
    phases: [
      { id: "A", name: "Draft" },
      { id: "B", name: "Revise" },
    ],
    phaseEdges: [{ from: "A", to: "B" }],
    exits: ["B"],
    sink: [],
  };
  const run: WorkflowRunState = {
    runId: "large",
    status: "running",
    usage: { spentTokens: 0, nodesUsed: 200 },
    actors: [
      { siteId: "actor#1", ordinal: 1, status: "running", name: "writer", phaseName: "Draft" },
    ],
    nodes: [
      {
        siteId: "ask#1",
        ordinal: 1,
        actorSiteId: "actor#1",
        actorOrdinal: 1,
        phase: "settled",
        outcome: "ok",
        phaseName: "Draft",
      },
      {
        siteId: "ask#1",
        ordinal: 2,
        actorSiteId: "actor#1",
        actorOrdinal: 1,
        phase: "executing",
        phaseName: "Revise",
      },
      ...Array.from({ length: 198 }, (_, i) => ({
        siteId: `unlisted#${i}`,
        ordinal: 1,
        phase: "settled" as const,
        outcome: "ok" as const,
        phaseName: "Draft",
      })),
    ],
    phases: [
      { name: "Draft", rounds: 1 },
      { name: "Revise", rounds: 2 },
    ],
    currentPhase: "Revise",
    lastEventSequence: 201,
  };
  const model = buildWorkflowTimeline(graph, run);
  assert.deepEqual(
    model.stations.map((station) => station.fraction),
    [
      { observed: 1, settled: 1 },
      { observed: 1, settled: 0 },
    ],
  );
  assert.deepEqual(
    model.stations.map((station) => station.status),
    ["done", "running"],
  );
  assert.deepEqual(
    model.stations.map((station) => station.pills[0]?.status),
    ["done", "running"],
  );
  assert.equal(model.runningIndex, 1);
});
