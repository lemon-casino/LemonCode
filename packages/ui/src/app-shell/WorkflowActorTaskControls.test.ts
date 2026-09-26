import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowRunNode } from "@zcode/shared/zcode-protocol-v4";
import {
  resolveWorkflowActorSupplementChange,
  selectWorkflowActorTask,
  updateWorkflowActorTaskError,
  workflowActorTaskActionState,
} from "./workflowActorTaskState.js";
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
    siteId: "ask#1",
    ordinal: 1,
    phase: "settled",
    outcome: "ok",
  };
  const run = { status: "running" } as WorkflowRunState;
  assert.equal(workflowActorTaskActionState(run, selected).waitingForRun, true);
  assert.equal(workflowActorTaskActionState(run, selected).canRevise, false);
  assert.equal(
    workflowActorTaskActionState({ ...run, status: "completed" }, selected).canRevise,
    true,
  );
  assert.equal(
    workflowActorTaskActionState({ ...run, status: "errored" }, { ...selected, outcome: "failed" })
      .canRevise,
    true,
  );
  assert.equal(workflowActorTaskActionState(run, { ...selected, phase: "paused" }).canRetry, true);
});

test("an over-limit edit preserves the previous actor supplement", () => {
  const previous = "a".repeat(32_768);

  assert.equal(resolveWorkflowActorSupplementChange(previous, `inserted${previous}`), previous);
  assert.equal(
    resolveWorkflowActorSupplementChange(previous, previous.slice(0, -1)),
    previous.slice(0, -1),
  );
});

test("a late task error remains scoped to the draft that issued the command", () => {
  const firstTaskErrors = updateWorkflowActorTaskError({}, "ask#1@1", "rejected");
  const bothTaskErrors = updateWorkflowActorTaskError(firstTaskErrors, "ask#2@1", "upload failed");

  assert.equal(firstTaskErrors["ask#2@1"], undefined);
  assert.equal(bothTaskErrors["ask#1@1"], "rejected");
  assert.equal(bothTaskErrors["ask#2@1"], "upload failed");
  assert.deepEqual(updateWorkflowActorTaskError(bothTaskErrors, "ask#1@1", undefined), {
    "ask#2@1": "upload failed",
  });
});
