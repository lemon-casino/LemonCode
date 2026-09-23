import assert from "node:assert/strict";
import test from "node:test";
import { hasRunningWorkspaceTask } from "./zcodeSessionStoreSelectors.js";

function workspaceBusyInput(
  input: {
    runtimeStatus?: "idle" | "creating" | "restoring" | "streaming";
    activeInputId?: string;
    persistedStatus?: "idle" | "running";
  } = {},
) {
  return {
    taskRuntimeByTaskId:
      input.runtimeStatus || input.activeInputId
        ? {
            task: {
              status: input.runtimeStatus ?? "idle",
              activeInputId: input.activeInputId,
            },
          }
        : {},
    taskListCache: input.persistedStatus ? [{ taskId: "task", status: input.persistedStatus }] : [],
    optimisticTaskListByTaskId: {},
  } as never;
}

test("workspace busy selector covers runtime phases and accepted input", () => {
  for (const runtimeStatus of ["creating", "restoring", "streaming"] as const) {
    assert.equal(hasRunningWorkspaceTask(workspaceBusyInput({ runtimeStatus })), true);
  }
  assert.equal(hasRunningWorkspaceTask(workspaceBusyInput({ activeInputId: "input" })), true);
});

test("workspace busy selector keeps task-index running as a second authority", () => {
  assert.equal(hasRunningWorkspaceTask(workspaceBusyInput({ persistedStatus: "running" })), true);
  assert.equal(hasRunningWorkspaceTask(workspaceBusyInput()), false);
});
