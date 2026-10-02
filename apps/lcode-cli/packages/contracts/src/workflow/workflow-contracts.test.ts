import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import {
  deriveWorkflowRunSchedulerState,
  deriveWorkflowSchedulerState,
  deriveWorkflowSessionLinks,
  ExpertWorkflowRunSnapshotSchema,
  ExpertWorkflowStrategySchema,
  WorkflowCriticResultSchema,
  WorkflowDefinitionSchema,
  WorkflowGraphSchema,
  WorkflowGraphSeedSchema,
  WorkflowNodePromptUpdateSchema,
  WorkflowPhaseDefinitionSchema,
  WorkflowRunSnapshotSchema,
  WorkflowSchedulerStateSchema,
  WorkflowStrategySchema,
} from "./index.js";

const strategy = {
  clarify: { confidenceThreshold: 0.5, maxRounds: 2, minRounds: 0 },
  executor: {
    drainingChangeHours: 1,
    frontierTarget: 2,
    maxConcurrentLoops: 2,
    maxConsecutiveErrors: 2,
    maxPlannerRuns: 2,
  },
  finalCritic: { maxIterations: 2 },
  reactLoop: { maxRounds: 2 },
};

function snapshot() {
  return WorkflowRunSnapshotSchema.parse({
    artifacts: [],
    createdAt: "2026-10-01",
    cwd: ".",
    graph: { edges: [], nodes: [] },
    kind: "review",
    phaseOrder: ["review"],
    phases: [],
    runId: "run",
    schemaVersion: 1,
    status: "running",
    strategy,
    task: "review",
    updatedAt: "2026-10-01",
  });
}

test("workflow public aliases retain Zod 3 schema identity and defaults", () => {
  assert.ok(WorkflowGraphSchema instanceof z.ZodObject);
  assert.equal(ExpertWorkflowRunSnapshotSchema, WorkflowRunSnapshotSchema);
  assert.equal(ExpertWorkflowStrategySchema, WorkflowStrategySchema);
  assert.equal(
    WorkflowPhaseDefinitionSchema.parse({ phase: "review", title: "Review", description: "Check" })
      .behavior,
    "agent",
  );
  assert.deepEqual(WorkflowGraphSeedSchema.parse({}), { collections: [], edges: [], nodes: [] });
  assert.deepEqual(WorkflowCriticResultSchema.parse({ verdict: "pass" }), {
    acceptanceGaps: [],
    reasoning: "",
    reopenProposals: [],
    verdict: "pass",
  });
  const run = snapshot();
  assert.deepEqual(run.activities, []);
  assert.deepEqual(run.sessionLinks, []);
  assert.deepEqual(run.recoveryActions, []);
  assert.equal(WorkflowNodePromptUpdateSchema.safeParse({ id: "node" }).success, false);
  assert.deepEqual(WorkflowNodePromptUpdateSchema.parse({ id: "node", title: "New" }), {
    id: "node",
    title: "New",
  });
});

test("workflow definitions preserve duplicate, missing and unknown phase validation", () => {
  const phase = { phase: "review", title: "Review", description: "Check" };
  const definition = {
    definitionId: "review",
    definitionVersion: "1",
    kind: "review",
    title: "Review",
    strategy,
    phaseOrder: ["review"],
    phases: [phase],
  };
  assert.equal(WorkflowDefinitionSchema.safeParse(definition).success, true);
  for (const candidate of [
    { ...definition, phases: [phase, phase] },
    { ...definition, phaseOrder: ["review", "review"] },
    { ...definition, phaseOrder: ["missing"] },
    { ...definition, phases: [phase, { ...phase, phase: "extra" }] },
  ]) {
    const result = WorkflowDefinitionSchema.safeParse(candidate);
    assert.equal(result.success, false);
    if (!result.success) assert.ok(result.error.issues.every((issue) => issue.code === "custom"));
  }
});

test("scheduler derivation keeps terminal dependencies, input order and collection facts", () => {
  const graph = WorkflowGraphSchema.parse({
    nodes: [
      { id: "failed", status: "failed", title: "failed" },
      { id: "done", status: "completed", title: "done" },
      {
        id: "ready",
        status: "pending",
        title: "ready",
        dependsOn: ["failed", "done"],
        collectionId: "work",
      },
      {
        id: "blocked",
        status: "pending",
        title: "blocked",
        dependsOn: ["absent"],
        collectionId: "work",
      },
      { id: "active", status: "active", title: "active" },
    ],
    edges: [
      { from: "done", to: "ready" },
      { from: "active", to: "blocked" },
    ],
    collections: [{ collectionId: "work", nodeIds: ["ready", "active"], frontierTarget: 3 }],
  });
  const before = structuredClone(graph);
  const state = deriveWorkflowSchedulerState(graph);
  assert.deepEqual(graph, before);
  assert.deepEqual(state.readyNodeIds, ["ready"]);
  assert.deepEqual(state.nodes[2]?.incoming, ["failed", "done"]);
  assert.deepEqual(state.blockedNodes, [{ nodeId: "blocked", blockedBy: ["absent", "active"] }]);
  assert.deepEqual(state.counts, {
    active: 1,
    blocked: 1,
    completed: 1,
    failed: 1,
    pending: 2,
    ready: 1,
    total: 5,
  });
  assert.equal(state.collectionStates[0]?.frontier, 3);
  assert.equal(state.collectionStates[0]?.status, "active");
  assert.deepEqual(state.collectionStates[0]?.readyNodeIds, ["ready"]);
  assert.deepEqual(WorkflowSchedulerStateSchema.parse(state), state);
});

test("run scheduling and session links preserve activity attempts and optional identities", () => {
  const run = snapshot();
  run.activities = [
    {
      activityId: "one",
      phase: "review",
      kind: "agent_session",
      status: "failed",
      startedAt: "1",
      inputArtifactPaths: [],
      outputArtifactPaths: [],
    },
    {
      activityId: "two",
      phase: "review",
      kind: "agent_session",
      status: "active",
      startedAt: "2",
      sessionId: "session",
      traceId: "trace",
      inputArtifactPaths: [],
      outputArtifactPaths: [],
    },
    {
      activityId: "three",
      phase: "review",
      nodeId: "node",
      kind: "actor_agent",
      status: "skipped",
      startedAt: "3",
      inputArtifactPaths: [],
      outputArtifactPaths: [],
    },
  ];
  const before = structuredClone(run);
  const state = deriveWorkflowRunSchedulerState(run);
  assert.deepEqual(state.activeChildSessionIds, ["session"]);
  assert.deepEqual(state.activeActivities, [
    { activityId: "two", phase: "review", sessionId: "session", traceId: "trace" },
  ]);
  const links = deriveWorkflowSessionLinks(run);
  assert.deepEqual(
    links.map((link) => link.attempt),
    [1, 2, 1],
  );
  assert.deepEqual(
    links.map((link) => link.status),
    ["failed", "running", "cancelled"],
  );
  assert.equal(Object.hasOwn(links[0]!, "sessionId"), false);
  assert.deepEqual(run, before);
});
