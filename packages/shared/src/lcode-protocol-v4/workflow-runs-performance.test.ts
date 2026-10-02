import assert from "node:assert/strict";
import test from "node:test";
import { reduceWorkflowRunsState } from "./workflow-runs-reducer.js";
import type { WorkflowRunNode, WorkflowRunsState } from "./workflow-runs.js";

function fixture() {
  const nodes: WorkflowRunNode[] = Array.from({ length: 256 }, (_, index) => ({
    siteId: "ask#parallel",
    ordinal: index + 1,
    actorSiteId: "actor#parallel",
    actorOrdinal: index + 1,
    phase: "executing",
  }));
  const state: WorkflowRunsState = {
    revision: 10,
    runs: [
      {
        runId: "large-run",
        status: "running",
        usage: { spentTokens: 100, nodesUsed: 256 },
        actors: nodes.map((node) => ({
          siteId: "actor#parallel",
          ordinal: node.ordinal,
          status: "running",
        })),
        nodes,
        lastEventSequence: 100,
      },
    ],
  };
  return state;
}

const activity = {
  kind: "text" as const,
  observedAt: 2_000,
  since: 1_000,
  requestsCompleted: 1,
  toolCalls: 2,
};

function protectUnrelatedNode(state: WorkflowRunsState) {
  let serializations = 0;
  Object.defineProperty(state.runs[0]!.nodes[255]!, "toJSON", {
    get() {
      serializations++;
      return undefined;
    },
  });
  return () => serializations;
}

function freezeState(state: WorkflowRunsState) {
  const run = state.runs[0]!;
  for (const node of run.nodes) Object.freeze(node);
  for (const actor of run.actors) Object.freeze(actor);
  Object.freeze(run.nodes);
  Object.freeze(run.actors);
  Object.freeze(run.usage);
  Object.freeze(run);
  Object.freeze(state.runs);
  Object.freeze(state);
}

test("sequenced activity does not serialize unrelated nodes and preserves prior snapshots", () => {
  const previous = fixture();
  const serialized = protectUnrelatedNode(previous);
  freezeState(previous);
  const next = reduceWorkflowRunsState(previous, {
    runId: "large-run",
    sequence: 101,
    eventType: "node-activity",
    payload: { instance: { siteId: "ask#parallel", ordinal: 1 }, activity },
  });
  assert.ok(next);
  assert.equal(serialized(), 0);
  assert.equal(next.revision, 11);
  assert.equal(next.runs[0]!.lastEventSequence, 101);
  assert.equal(previous.runs[0]!.nodes[0]!.activity, undefined);
  assert.deepEqual(next.runs[0]!.nodes[0]!.activity, activity);
  assert.notEqual(next.runs[0]!.nodes[0], previous.runs[0]!.nodes[0]);
  assert.equal(next.runs[0]!.nodes[255], previous.runs[0]!.nodes[255]);
  assert.equal(next.runs[0]!.actors, previous.runs[0]!.actors);
  assert.equal(next.runs[0]!.usage, previous.runs[0]!.usage);
});

test("unknown and rejected observations keep their original watermark-only behavior", () => {
  for (const envelope of [
    { eventType: "log", payload: { text: "synthetic" } },
    {
      eventType: "node-activity",
      payload: { instance: { siteId: "absent", ordinal: 1 }, activity },
    },
    {
      eventType: "node-activity",
      payload: {
        instance: { siteId: "ask#parallel", ordinal: 1 },
        activity: { ...activity, observedAt: -1 },
      },
    },
  ]) {
    const previous = fixture();
    const serialized = protectUnrelatedNode(previous);
    const next = reduceWorkflowRunsState(previous, {
      ...envelope,
      runId: "large-run",
      sequence: 101,
    });
    assert.ok(next);
    assert.equal(serialized(), 0);
    assert.equal(next.runs[0]!.lastEventSequence, 101);
    assert.equal(next.runs[0]!.nodes, previous.runs[0]!.nodes);
    assert.equal(next.runs[0]!.actors, previous.runs[0]!.actors);
  }
});

test("legacy envelopes without sequence remain semantically idempotent", () => {
  const previous = fixture();
  const envelope = {
    runId: "large-run",
    eventType: "usage-updated",
    payload: { spentTokens: 200 },
  };
  const next = reduceWorkflowRunsState(previous, envelope);
  assert.ok(next);
  assert.equal(next.runs[0]!.usage.spentTokens, 200);
  assert.equal(next.runs[0]!.lastEventSequence, 100);
  assert.equal(reduceWorkflowRunsState(next, envelope), null);
  assert.equal(reduceWorkflowRunsState(next, { runId: "large-run", eventType: "unknown" }), null);
});

test("non-standard sequence values retain legacy JSON equality semantics", () => {
  for (const lastEventSequence of [Number.NaN, Number.NEGATIVE_INFINITY]) {
    const previous = fixture();
    previous.runs[0]!.lastEventSequence = lastEventSequence;
    assert.equal(
      reduceWorkflowRunsState(previous, {
        runId: "large-run",
        sequence: Number.POSITIVE_INFINITY,
        eventType: "unknown",
      }),
      null,
    );
  }
});

test("stale lifecycle and activity envelopes return before traversing the run", () => {
  const previous = fixture();
  const serialized = protectUnrelatedNode(previous);
  for (const sequence of [99, 100]) {
    for (const eventType of ["run-started", "node-queued", "node-activity", "run-settled"]) {
      assert.equal(
        reduceWorkflowRunsState(previous, {
          runId: "large-run",
          sequence,
          eventType,
          payload: { instance: { siteId: "ask#parallel", ordinal: 1 }, activity },
        }),
        null,
      );
    }
  }
  assert.equal(serialized(), 0);
  assert.equal(previous.revision, 10);
});
