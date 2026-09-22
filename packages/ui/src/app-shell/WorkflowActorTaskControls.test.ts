import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowRunNode } from "@zcode/shared/zcode-protocol-v4";
import { selectWorkflowActorTask, workflowActorTaskActionState } from "./workflowActorTaskState.js";
import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";

test("a phase click focuses its ask while explicit task selection takes precedence", () => {
  const nodes: WorkflowRunNode[] = [
    { siteId: "ask#1", ordinal: 1, phase: "settled", phaseName: "Draft" },
    { siteId: "ask#2", ordinal: 1, phase: "executing", phaseName: "Review" },
  ];
  assert.equal(selectWorkflowActorTask(nodes, undefined, "Draft")?.siteId, "ask#1");
  assert.equal(selectWorkflowActorTask(nodes, "ask#2@1", "Draft")?.siteId, "ask#2");
});

test("completed tasks revise only after the predecessor settles", () => {
  const selected: WorkflowRunNode = {
    siteId: "ask#1", ordinal: 1, phase: "settled", outcome: "ok",
  };
  const run = { status: "running" } as WorkflowRunState;
  assert.equal(workflowActorTaskActionState(run, selected).waitingForRun, true);
  assert.equal(workflowActorTaskActionState(run, selected).canRevise, false);
  assert.equal(workflowActorTaskActionState({ ...run, status: "completed" }, selected).canRevise, true);
  assert.equal(workflowActorTaskActionState({ ...run, status: "errored" }, { ...selected, outcome: "failed" }).canRevise, true);
  assert.equal(workflowActorTaskActionState(run, { ...selected, phase: "paused" }).canRetry, true);
});
