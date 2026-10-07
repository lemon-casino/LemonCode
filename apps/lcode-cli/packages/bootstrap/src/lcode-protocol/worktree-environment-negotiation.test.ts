import assert from "node:assert/strict";
import test from "node:test";
import {
  lcodeProtocolMethods as methods,
  type LCodeWorkspaceRef,
  type WorktreeExecutionBinding,
} from "@lcode/shared";
import { prepareProtocolExecution, restoreProtocolExecution } from "./worktree-execution.js";
import type { LCodeProtocolAgentServerContext } from "./server-types.js";

const environmentRef = { environmentId: "a".repeat(32), revision: 1, manifestDigest: "frozen" };
const origin = { workspacePath: "/origin", workspaceKey: "/origin" };
const binding: WorktreeExecutionBinding = {
  id: "binding",
  taskId: "root",
  requestId: "request",
  originalWorkspacePath: "/origin",
  workspacePath: "/tree",
  repositoryRoot: "/origin",
  commonDirectory: "/origin/.git",
  checkoutPath: "/tree",
  branch: "task",
  baseCommit: "abc",
  targetBranch: "main",
  sourceFolderPaths: ["/tree"],
  status: "ready",
  createdAt: "now",
  updatedAt: "now",
  environmentRef,
};
const capabilities = {
  managedEnvironments: true,
  protocolVersion: 1,
  actions: ["prepare", "resolveContext", "retainSession", "releaseConsumer"],
};
function prepareFixture(caps: unknown = capabilities, answer = binding) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const context = {
    requestClient: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === methods.runtimeEnvironmentCapabilities) {
        if (caps instanceof Error) throw caps;
        return { capabilities: caps };
      }
      if (method === methods.worktreePrepareExecution) return answer;
      if (method === methods.runtimeEnvironmentRetainSession) return { retained: true };
      throw new Error(`Unexpected method ${method}`);
    },
  } as unknown as LCodeProtocolAgentServerContext;
  return { context, calls };
}
const input = {
  workspace: origin,
  execution: { mode: "worktree" as const, environmentPolicy: "managed" as const },
  taskId: "root",
  requestId: "request",
};

test("managed preparation negotiates Host capabilities before prepare and forwards frozen policy", async () => {
  const f = prepareFixture();
  const result = await prepareProtocolExecution(f.context, input);
  assert.deepEqual(
    f.calls.map((call) => call.method),
    [
      methods.runtimeEnvironmentCapabilities,
      methods.worktreePrepareExecution,
      methods.runtimeEnvironmentRetainSession,
    ],
  );
  assert.deepEqual(f.calls[0]?.params, { workspacePath: "/origin" });
  assert.equal(f.calls[1]?.params.environmentPolicy, "managed");
  assert.deepEqual(result.workspace.environmentRef, environmentRef);
});
for (const caps of [
  { managedEnvironments: false, missingReason: "unsupported" },
  { managedEnvironments: true },
  { ...capabilities, protocolVersion: 2 },
  { ...capabilities, actions: ["prepare"] },
  new Error("Method not found: runtimeEnvironment/capabilities"),
]) {
  test(`managed preparation fails before worktree prepare for ${JSON.stringify(caps)}`, async () => {
    const f = prepareFixture(caps);
    await assert.rejects(prepareProtocolExecution(f.context, input));
    assert.deepEqual(
      f.calls.map((call) => call.method),
      [methods.runtimeEnvironmentCapabilities],
    );
  });
}

test("managed preparation rejects a Host binding without a usable managed ref", async () => {
  for (const ref of [undefined, { ...environmentRef, revision: 0 }]) {
    const f = prepareFixture(capabilities, { ...binding, environmentRef: ref });
    await assert.rejects(prepareProtocolExecution(f.context, input), /environment/);
    assert.equal(f.calls.length, 2);
  }
});

test("inherit and legacy preparation do not query managed capability and keep the frozen policy", async () => {
  for (const policy of [undefined, "inherit" as const]) {
    const f = prepareFixture(undefined, { ...binding, environmentRef: undefined });
    await prepareProtocolExecution(f.context, {
      ...input,
      execution: { mode: "worktree", environmentPolicy: policy },
    });
    assert.deepEqual(
      f.calls.map((call) => call.method),
      [methods.worktreePrepareExecution],
    );
    assert.equal(f.calls[0]?.params.environmentPolicy, policy);
  }
});

function restoreFixture(ref: LCodeWorkspaceRef, answer: WorktreeExecutionBinding) {
  const calls: string[] = [];
  const context = {
    deps: { sessionStore: { sessionEntries: async () => [{ data: ref }] } },
    requestClient: async (method: string) => {
      calls.push(method);
      if (method === methods.worktreeGetBinding) return { binding: answer };
      if (method === methods.runtimeEnvironmentRetainSession) return { retained: true };
      throw new Error(`Unexpected method ${method}`);
    },
  } as unknown as LCodeProtocolAgentServerContext;
  return { context, calls };
}
const reference: LCodeWorkspaceRef = {
  workspacePath: "/tree",
  workspaceKey: "/tree",
  executionBindingId: "binding",
  originWorkspacePath: "/origin",
  environmentRef,
};
test("legacy persisted worktree without environmentRef is not implicitly upgraded from Host binding", async () => {
  const f = restoreFixture({ ...reference, environmentRef: undefined }, binding);
  const result = await restoreProtocolExecution(f.context, {
    taskId: "root",
    workspace: origin,
    persistedWorkspace: reference,
  });
  assert.equal(result.workspace.environmentRef, undefined);
  assert.deepEqual(f.calls, [methods.worktreeGetBinding]);
});
for (const changed of [
  { originalWorkspaceIdentity: "wrong-origin" },
  { workspaceIdentity: "wrong-tree" },
  { originalWorkspacePath: "/wrong" },
  { environmentRef: { ...environmentRef, manifestDigest: "different" } },
]) {
  test(`restore refuses changed owner identity/reference ${JSON.stringify(changed)}`, async () => {
    const f = restoreFixture(reference, { ...binding, ...changed });
    await assert.rejects(
      restoreProtocolExecution(f.context, {
        taskId: "root",
        workspace: origin,
        persistedWorkspace: reference,
      }),
      /identity|reference/,
    );
    assert.deepEqual(f.calls, [methods.worktreeGetBinding]);
  });
}
