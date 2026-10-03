import assert from "node:assert/strict";
import test from "node:test";
import { createSessionId } from "@lcode/contracts";
import type { WorktreeExecutionBinding } from "@lcode/shared";
import { prepareProtocolExecution, restoreProtocolExecution } from "./worktree-execution.js";
import type { LCodeProtocolAgentServerContext } from "./server-types.js";

const taskId = createSessionId("fixture");
const binding: WorktreeExecutionBinding = {
  id: "binding",
  taskId,
  requestId: "request",
  originalWorkspacePath: "/origin",
  workspacePath: "/tree",
  repositoryRoot: "/origin",
  commonDirectory: "/origin/.git",
  checkoutPath: "/tree",
  branch: "codex/task",
  baseCommit: "abc",
  targetBranch: "main",
  sourceFolderPaths: ["/tree"],
  status: "ready",
  createdAt: "now",
  updatedAt: "now",
};
const original = { workspacePath: "/origin", workspaceKey: "/origin" };

test("worktree preparation returns fixed execution path after the owner answers", async () => {
  let request: unknown;
  const context = {
    requestClient: async (_method: unknown, params: unknown) => {
      request = params;
      return binding;
    },
  } as unknown as LCodeProtocolAgentServerContext;
  const prepared = await prepareProtocolExecution(context, {
    workspace: original,
    execution: { mode: "worktree", taskName: "修复模型切换" },
    taskId,
    requestId: "request",
  });
  assert.equal(prepared.workspace.workspacePath, "/tree");
  assert.equal(prepared.workspace.originWorkspacePath, "/origin");
  assert.equal(prepared.workspace.executionBindingId, "binding");
  assert.equal((request as { taskId: string }).taskId, taskId);
  assert.equal((request as { taskName: string }).taskName, "修复模型切换");
});

test("local execution does not request or silently create a worktree", async () => {
  const context = {
    requestClient: async () => {
      throw new Error("unexpected request");
    },
  } as unknown as LCodeProtocolAgentServerContext;
  const prepared = await prepareProtocolExecution(context, {
    workspace: original,
    taskId,
    requestId: "request",
  });
  assert.equal(prepared.workspace, original);
});

test("worktree preparation fails closed for wrong task and non-ready bindings", async () => {
  for (const answer of [
    { ...binding, taskId: "different" },
    { ...binding, status: "missing" },
  ]) {
    const context = {
      requestClient: async () => answer,
    } as unknown as LCodeProtocolAgentServerContext;
    await assert.rejects(
      prepareProtocolExecution(context, {
        workspace: original,
        execution: { mode: "worktree" },
        taskId,
        requestId: "request",
      }),
      /binding/,
    );
  }
});

test("cold restore resolves the persisted reference and refuses a missing owner binding", async () => {
  const reference = {
    workspacePath: "/tree",
    workspaceKey: "/tree",
    executionBindingId: "binding",
    originWorkspacePath: "/origin",
  };
  const context = {
    deps: { sessionStore: { sessionEntries: async () => [{ data: reference }] } },
    requestClient: async () => ({ binding }),
  } as unknown as LCodeProtocolAgentServerContext;
  const restored = await restoreProtocolExecution(context, {
    taskId,
    workspace: original,
    persistedWorkspace: { workspacePath: "/tree", workspaceKey: "/tree" },
  });
  assert.equal(restored.workspace.workspacePath, "/tree");
  context.requestClient = async () => ({ binding: null }) as never;
  await assert.rejects(
    restoreProtocolExecution(context, {
      taskId,
      workspace: original,
      persistedWorkspace: { workspacePath: "/tree", workspaceKey: "/tree" },
    }),
    /binding/,
  );
});

test("cold restore rejects a persisted execution path changed outside its binding", async () => {
  const context = {
    deps: {
      sessionStore: {
        sessionEntries: async () => [
          {
            data: {
              workspacePath: "/tree",
              workspaceKey: "/tree",
              executionBindingId: "binding",
              originWorkspacePath: "/origin",
            },
          },
        ],
      },
    },
    requestClient: async () => ({ binding }),
  } as unknown as LCodeProtocolAgentServerContext;
  await assert.rejects(
    restoreProtocolExecution(context, {
      taskId,
      workspace: original,
      persistedWorkspace: original,
    }),
    /path/,
  );
});

test("preparation forwards setup authorization and retains remote attachment identity", async () => {
  let request: Record<string, unknown> | undefined;
  const context = {
    requestClient: async (_method: unknown, params: Record<string, unknown>) => {
      request = params;
      return {
        ...binding,
        originalWorkspaceIdentity: "remote-origin",
        workspaceIdentity: "remote-tree",
      };
    },
  } as unknown as LCodeProtocolAgentServerContext;
  const prepared = await prepareProtocolExecution(context, {
    workspace: {
      ...original,
      workspaceKey: "remote-origin",
      workspaceIdentity: "remote-origin",
      remoteSessionId: "attachment",
    },
    execution: {
      mode: "worktree",
      setupCommands: ["pnpm install"],
      copyIgnoredPaths: ["local.config"],
      retrySetup: true,
    },
    taskId,
    requestId: "request",
  });
  assert.equal(prepared.workspace.workspaceIdentity, "remote-tree");
  assert.equal(prepared.workspace.remoteSessionId, "attachment");
  assert.deepEqual(request?.setupCommands, ["pnpm install"]);
  assert.deepEqual(request?.copyIgnoredPaths, ["local.config"]);
  assert.equal(request?.retrySetup, true);
});

test("fork restore registers the persisted child-parent relation and retains the root owner", async () => {
  const childId = "fork-child";
  const ownerRef = {
    workspacePath: "/tree",
    workspaceKey: "/tree",
    executionBindingId: "binding",
    originWorkspacePath: "/origin",
  };
  const childRef = { ...ownerRef, bindingOwnerTaskId: taskId };
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const context = {
    deps: {
      sessionStore: {
        sessionEntries: async ({ sessionID }: { sessionID: string }) => [
          { data: sessionID === childId ? childRef : ownerRef },
        ],
        getSession: async (id: string) => ({
          id,
          path: "/tree",
          directory: "/tree",
          ...(id === childId ? { parentID: taskId } : {}),
        }),
      },
    },
    requestClient: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      return method.includes("prepare") ? binding : { binding };
    },
  } as unknown as LCodeProtocolAgentServerContext;
  const restored = await restoreProtocolExecution(context, {
    taskId: childId,
    workspace: original,
    persistedWorkspace: ownerRef,
  });
  assert.equal(restored.workspace.bindingOwnerTaskId, taskId);
  assert.deepEqual(calls[0]?.params.parentBinding, {
    bindingId: "binding",
    bindingOwnerTaskId: taskId,
    parentTaskId: taskId,
  });
  assert.equal(calls[1]?.params.taskId, taskId);
});
