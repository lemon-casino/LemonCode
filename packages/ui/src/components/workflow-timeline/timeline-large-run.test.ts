import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowRunNode, WorkflowRunState } from "@lcode/shared/lcode-protocol-v4";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";
import { buildWorkflowTimeline } from "./timeline-model.js";
import { workflowPillActivity } from "./timeline-activity.js";
import { liveParticipantView } from "@/components/workflow-graph/participant-model.js";
import { workflowRunNodeIndex } from "@/components/workflow-graph/run-node-index.js";

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

function indexedLoad(actors = 256) {
  const graph: WorkflowCausalityGraphData = {
    lanes: [{ id: "actor#parallel", name: "Synthetic actors" }],
    steps: [{ id: "ask#work", kind: "ask", label: "Work", lane: "actor#parallel", phase: "load" }],
    participants: [
      { id: "parallel-load", lane: "actor#parallel", phase: "load", steps: ["ask#work"] },
    ],
    phases: [{ id: "load", name: "Load" }],
    handoffs: [],
  };
  const reads = { identities: 0 };
  const identityFields = new Set(["siteId", "ordinal", "actorSiteId", "actorOrdinal", "phaseName"]);
  const nodes: WorkflowRunNode[] = Array.from({ length: actors }, (_, index) => {
    const node: WorkflowRunNode = {
      siteId: "ask#work",
      ordinal: index + 1,
      actorSiteId: "actor#parallel",
      actorOrdinal: index + 1,
      phase: "executing",
      phaseName: "Load",
    };
    Object.freeze(node);
    return new Proxy(node, {
      get(target, key, receiver) {
        if (typeof key === "string" && identityFields.has(key)) reads.identities++;
        return Reflect.get(target, key, receiver);
      },
    });
  });
  const run: WorkflowRunState = {
    runId: "indexed-load",
    status: "running",
    currentPhase: "Load",
    lastEventSequence: 1,
    usage: { spentTokens: 0, nodesUsed: actors },
    actors: Array.from({ length: actors }, (_, index) =>
      Object.freeze({
        siteId: "actor#parallel",
        ordinal: index + 1,
        status: "running" as const,
        phaseName: "Load",
      }),
    ),
    nodes,
  };
  Object.freeze(run.nodes);
  Object.freeze(run.actors);
  Object.freeze(run.usage);
  Object.freeze(run);
  return { graph, run, reads };
}

test("256 same-site actors build the model with bounded linear identity reads", () => {
  const { graph, run, reads } = indexedLoad();
  const before = JSON.stringify(run);
  reads.identities = 0;
  const model = buildWorkflowTimeline(graph, run);
  const identityReads = reads.identities;
  assert.equal(model.stations[0]!.pills.length, 256);
  assert.equal(model.stations[0]!.status, "running");
  assert.ok(model.stations[0]!.pills.every((pill) => pill.status === "running"));
  assert.equal(JSON.stringify(run), before, "deriving a view never mutates the published snapshot");
  assert.ok(
    identityReads <= 64 * run.nodes.length,
    `identity reads ${identityReads} exceed a linear model budget`,
  );
});

test("instance status lookup narrows a shared site by actor ordinal before scanning", () => {
  const { graph, run, reads } = indexedLoad();
  const view = liveParticipantView(graph, run);
  assert.equal(view.graph.participants.length, 256);
  assert.ok(Object.values(view.participantStatuses).every((status) => status === "running"));
  assert.ok(
    reads.identities <= 32 * run.nodes.length,
    `identity reads ${reads.identities} include repeated lane scans`,
  );
});

test("per-pill activity shares the current window index instead of rescanning all nodes", () => {
  const { run, reads } = indexedLoad();
  const activities = run.nodes.map((node) => workflowPillActivity([node], run, true, false, {}));
  assert.ok(activities.every((activity) => activity.kind === "unknown"));
  assert.ok(
    reads.identities <= 32 * run.nodes.length,
    `identity reads ${reads.identities} include repeated window scans`,
  );
});

test("compound indexes keep opaque site and actor identifiers separate", () => {
  const first: WorkflowRunNode = {
    siteId: "site@1",
    ordinal: 2,
    actorSiteId: "lane\u0000@3",
    actorOrdinal: 4,
    phase: "settled",
    outcome: "ok",
    settledAt: 100,
  };
  const next: WorkflowRunNode = {
    ...first,
    ordinal: 3,
    phase: "executing",
    outcome: undefined,
    settledAt: undefined,
  };
  const otherSite: WorkflowRunNode = {
    ...next,
    siteId: "site",
    ordinal: 12,
    actorSiteId: "lane",
    actorOrdinal: 34,
  };
  const otherOrdinal: WorkflowRunNode = { ...next, ordinal: 4, actorOrdinal: 34 };
  const incomplete: WorkflowRunNode = { ...next, ordinal: 5, actorOrdinal: undefined };
  const nodes = [first, otherSite, next, otherOrdinal, incomplete];
  Object.freeze(nodes);
  const index = workflowRunNodeIndex(nodes);
  assert.deepEqual(index.forActor("site@1", "lane\u0000@3", 4), [first, next]);
  assert.deepEqual(index.forActor("site", "lane", 34), [otherSite]);
  assert.deepEqual(index.forActor("site@1", "lane\u0000@3", 34), [otherOrdinal]);
  assert.deepEqual(index.forActor("site@1", "lane\u0000@3", undefined), [incomplete]);
  assert.deepEqual(index.inProjectionOrder([{ ...next }, otherSite, next]), [otherSite, next]);
  assert.equal(index.deliveredAt(next), 100);
  assert.equal(index.deliveredAt(otherSite), undefined);
  assert.equal(index.deliveredAt(otherOrdinal), undefined);
  assert.equal(index.deliveredAt(incomplete), undefined);
  assert.equal(workflowRunNodeIndex(nodes), index);
  assert.notEqual(
    workflowRunNodeIndex([...nodes]),
    index,
    "new wire arrays get a new derived index",
  );
});

test("member binding keeps ordinal order, phase fallback and distinct actor status", () => {
  const { graph, run } = indexedLoad(3);
  const memberGraph: WorkflowCausalityGraphData = {
    ...graph,
    participants: [0, 1, 2].map((index) => ({
      ...graph.participants[0]!,
      id: `member-${index}`,
      member: { index, of: 3 },
    })),
  };
  const current: WorkflowRunState = {
    ...run,
    actors: [run.actors[2]!, run.actors[0]!, run.actors[1]!],
    nodes: [
      { ...run.nodes[2]!, phase: "queued" },
      { ...run.nodes[0]!, phase: "settled", outcome: "failed" },
      { ...run.nodes[1]!, phase: "settled", outcome: "cancelled" },
    ],
  };
  for (const phaseName of ["Load", "not in display", undefined]) {
    const compatible = {
      ...current,
      actors: current.actors.map((actor) => ({ ...actor, phaseName })),
      nodes: current.nodes.map((node) => ({ ...node, phaseName })),
    };
    const model = buildWorkflowTimeline(memberGraph, compatible);
    assert.deepEqual(
      model.stations[0]!.pills.map((pill) => pill.status),
      ["failed", "cancelled", "pending"],
    );
    assert.deepEqual(
      model.stations[0]!.pills.map((pill) => pill.instance?.ordinal),
      [1, 2, 3],
    );
    assert.deepEqual(
      model.stations[0]!.pills.map((pill) => pill.key),
      ["member-0", "member-1", "member-2"],
    );
  }
});
