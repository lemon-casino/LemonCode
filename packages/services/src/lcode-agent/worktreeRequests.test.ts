import assert from "node:assert/strict";
import test from "node:test";
import { handleWorktreeRequest } from "./worktreeRequests.js";

const workspace = { workspacePath: "/project", workspaceIdentity: "host-a" };
test("worktree requests reject malformed and cross-environment input before service IO", async () => {
  let called = false;
  const service = {
    prepare: async () => {
      called = true;
      throw new Error("should not run");
    },
  };
  await assert.rejects(
    handleWorktreeRequest(
      "worktree/prepareExecution",
      { ...workspace, workspaceIdentity: "host-b", taskId: "t", requestId: "r" },
      workspace,
      service as never,
    ),
    /scope/i,
  );
  await assert.rejects(
    handleWorktreeRequest(
      "worktree/prepareExecution",
      { ...workspace, taskId: "t" },
      workspace,
      service as never,
    ),
  );
  assert.equal(called, false);
});

test("an unavailable host fails explicitly instead of silently executing locally", async () => {
  await assert.rejects(
    handleWorktreeRequest("worktree/getBinding", { ...workspace, taskId: "t" }, workspace),
    /not available/i,
  );
});

test("writer permits accept only the original checkout or the registered task binding", async () => {
  let acquired = "";
  const service = {
    getBinding: async () => ({
      workspacePath: "/managed/task",
      workspaceIdentity: "task-identity",
      status: "ready",
    }),
    acquireCheckout: async (params: { workspacePath: string }) => {
      acquired = params.workspacePath;
      return { token: "permit" };
    },
  };
  assert.deepEqual(
    await handleWorktreeRequest(
      "checkout/acquireWriter",
      {
        workspacePath: "/managed/task",
        workspaceIdentity: "task-identity",
        sessionId: "t",
        requestId: "r",
      },
      workspace,
      service as never,
    ),
    { permitId: "permit" },
  );
  assert.equal(acquired, "/managed/task");
  await assert.rejects(
    handleWorktreeRequest(
      "checkout/acquireWriter",
      { workspacePath: "/elsewhere", sessionId: "t", requestId: "r" },
      workspace,
      service as never,
    ),
    /scope/i,
  );
});
