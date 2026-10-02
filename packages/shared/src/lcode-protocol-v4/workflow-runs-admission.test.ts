import assert from "node:assert/strict";
import test from "node:test";
import { workflowNodeQueueSchema } from "./workflow-activity.js";
import { reduceWorkflowRunsState } from "./workflow-runs-reducer.js";
import { workflowRunNodeSchema, type WorkflowRunsState } from "./workflow-runs.js";

const instance = { siteId: "ask#two", ordinal: 1 };
const blockedBy = { siteId: "ask#one", ordinal: 1 };

function fixture() {
  let state: WorkflowRunsState | undefined;
  let sequence = 0;
  const send = (eventType: string, payload: Record<string, unknown>, occurredAt?: number) => {
    state = reduceWorkflowRunsState(state, {
      runId: "run-one", sequence: ++sequence, eventType, payload,
      ...(occurredAt === undefined ? {} : { occurredAt }),
    }) ?? state;
  };
  send("run-started", {});
  send("node-queued", { instance, kind: "ask" });
  return { send, node: () => state!.runs[0]!.nodes[0]!, state: () => state! };
}

test("actor FIFO and run capacity are distinct queued observations, not provider waits", () => {
  const f = fixture();
  f.send("node-admission", { instance, cause: "actor-fifo", blockedBy }, 1_000);
  assert.equal(f.node().phase, "queued");
  assert.equal(f.node().wait, undefined);
  assert.deepEqual(f.node().queue, { cause: "actor-fifo", since: 1_000, blockedBy });
  f.send("node-admission", { instance, cause: "actor-fifo", blockedBy }, 1_100);
  assert.equal(f.node().queue?.since, 1_000);
  f.send("node-admission", { instance, cause: "actor-fifo", blockedBy: { ...blockedBy, attempt: 2 } }, 1_150);
  assert.equal(f.node().queue?.since, 1_150);
  f.send("node-admission", { instance, cause: "run-capacity" }, 1_200);
  assert.deepEqual(f.node().queue, { cause: "run-capacity", since: 1_200 });
  f.send("node-dispatched", { instance }, 1_500);
  assert.equal(f.node().queue, undefined);
  f.send("node-waiting", { instance, cause: "slot" }, 1_600);
  assert.equal(f.node().wait?.cause, "slot");
});

test("slot reservation clears old queue during session creation without pretending dispatch", () => {
  const f = fixture();
  f.send("node-admission", { instance, cause: "run-capacity" }, 1_000);
  f.send("node-admission", { instance, cause: null }, 1_100);
  assert.equal(f.node().phase, "queued");
  assert.equal(f.node().queue, undefined);
  assert.equal(f.node().activity, undefined);
  assert.equal(f.state().runs[0]!.usage.nodesUsed, 0);
  f.send("node-dispatched", { instance }, 1_200);
  assert.equal(f.node().phase, "dispatched");
  f.send("node-admission", { instance, cause: null }, 1_300);
  assert.equal(f.node().phase, "dispatched");
});

test("stale, foreign-attempt, paused or dispatched admission cannot overwrite current state", () => {
  const f = fixture();
  f.send("node-admission", { instance, cause: "actor-fifo", blockedBy }, 1_000);
  f.send("node-paused", { instance });
  assert.equal(f.node().queue, undefined);
  f.send("node-admission", { instance, cause: "run-capacity" }, 2_000);
  assert.equal(f.node().queue, undefined);
  const next = { ...instance, attempt: 2 };
  f.send("node-retried", { instance: next });
  f.send("node-admission", { instance, cause: "run-capacity" }, 2_100);
  assert.equal(f.node().queue, undefined);
  f.send("node-admission", { instance: next, cause: "actor-fifo", blockedBy }, 2_200);
  assert.equal(f.node().queue?.cause, "actor-fifo");
  const before = f.state();
  assert.equal(reduceWorkflowRunsState(before, {
    runId: "run-one", sequence: 1, eventType: "node-admission",
    payload: { instance: next, cause: "run-capacity" }, occurredAt: 3_000,
  }), null);
  f.send("node-admission", { instance: { ...instance, attempt: 3 }, cause: "run-capacity" }, 2_500);
  assert.equal(f.node().queue?.cause, "actor-fifo");
  f.send("node-dispatched", { instance: next });
  f.send("node-admission", { instance: next, cause: "run-capacity" }, 3_100);
  assert.equal(f.node().queue, undefined);
});

test("queue facts survive replay without inventing source time and use strict bounded schema", () => {
  const f = fixture();
  f.send("node-admission", { instance, cause: "run-capacity" });
  assert.deepEqual(f.node().queue, { cause: "run-capacity" });
  workflowRunNodeSchema.parse(f.node());
  for (const value of [
    { cause: "provider" }, { cause: "actor-fifo", since: -1 },
    { cause: "actor-fifo", blockedBy: { siteId: "x".repeat(65), ordinal: 1 } },
    { cause: "actor-fifo", blockedBy: { ...blockedBy, attempt: 0 } },
    { cause: "run-capacity", secret: "raw" },
  ]) assert.equal(workflowNodeQueueSchema.safeParse(value).success, false);
  f.send("run-settled", { status: "stopped", stopReason: "user" });
  f.send("node-admission", { instance, cause: "actor-fifo", blockedBy }, 4_000);
  assert.equal(f.node().queue?.cause, "run-capacity");
});
