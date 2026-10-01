import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowRunNode } from "@lcode/shared/lcode-protocol-v4";
import { aggregateRunStatuses, statusOfRunNode } from "./run-status.js";

const node = (
  phase: WorkflowRunNode["phase"],
  outcome?: WorkflowRunNode["outcome"],
): WorkflowRunNode => {
  const base = { ordinal: 0, phase, siteId: "agent" };
  return outcome === undefined ? base : { ...base, outcome };
};

test("settled outcomes keep cancelled apart from failed", () => {
  assert.equal(statusOfRunNode(node("settled", "ok")), "done");
  assert.equal(statusOfRunNode(node("settled", "failed")), "failed");
  assert.equal(statusOfRunNode(node("settled", "cancelled")), "cancelled");
});

test("only executing phases read as running", () => {
  for (const phase of ["executing", "repairing", "nudged"] as const) {
    assert.equal(statusOfRunNode(node(phase)), "running", phase);
  }
  for (const phase of ["queued", "dispatched", "waiting", "paused"] as const) {
    assert.equal(statusOfRunNode(node(phase)), "pending", phase);
  }
});

test("an absent multiset is not a status", () => {
  assert.equal(aggregateRunStatuses([]), undefined);
});

test("running outranks every settled verdict", () => {
  assert.equal(aggregateRunStatuses(["running", "failed", "cancelled"]), "running");
});

test("queued plus settled reads as running, queued alone stays pending", () => {
  assert.equal(aggregateRunStatuses(["pending", "done"]), "running");
  assert.equal(aggregateRunStatuses(["pending", "cancelled"]), "running");
  assert.equal(aggregateRunStatuses(["pending", "pending"]), "pending");
});

test("a real failure outranks a stop, and a stop outranks success", () => {
  assert.equal(aggregateRunStatuses(["failed", "cancelled"]), "failed");
  assert.equal(aggregateRunStatuses(["cancelled", "done"]), "cancelled");
  assert.equal(aggregateRunStatuses(["done", "done"]), "done");
  assert.equal(aggregateRunStatuses(["cancelled", "cancelled"]), "cancelled");
});
