import assert from "node:assert/strict";
import test from "node:test";
import { ProxyChannel } from "@lcode/rpc";
import type {
  RuntimeEnvironmentProjection,
  RuntimeEnvironmentScope,
  WorktreeExecutionBinding,
} from "@lcode/shared";
import type { IWorktreeService } from "../worktree/contract.js";
import { createPublicWorktreeService } from "../worktree/node.js";
import type { IRuntimeEnvironmentHostService, IRuntimeEnvironmentService } from "./contract.js";
import { createPublicRuntimeEnvironmentService } from "./publicService.js";

function fixture(attachment: boolean) {
  const origin = { workspacePath: "/repo", workspaceIdentity: "project-a" };
  const execution = { workspacePath: "/checkout/packages/app", workspaceIdentity: "execution-a" };
  const environmentId = "a".repeat(32);
  const binding: WorktreeExecutionBinding = {
    id: "b".repeat(32),
    taskId: "task",
    requestId: "create",
    ...execution,
    checkoutPath: "/checkout",
    originalWorkspacePath: origin.workspacePath,
    originalWorkspaceIdentity: origin.workspaceIdentity,
    repositoryRoot: "/repo",
    commonDirectory: "/repo/.git",
    branch: "lcode/task-环境读取",
    baseCommit: "base",
    targetBranch: "main",
    sourceFolderPaths: ["/checkout"],
    status: "ready",
    createdAt: "now",
    updatedAt: "now",
    environmentRef: { environmentId, revision: 2, manifestDigest: "digest" },
  };
  const listScopes: RuntimeEnvironmentScope[] = [];
  // 使用真实工作树公开入口的严格校验，不能由接受任意对象的 list 桩掩盖跨模块参数错误。
  const worktrees = createPublicWorktreeService({
    list: async (params: RuntimeEnvironmentScope) => {
      listScopes.push(params);
      return [binding];
    },
  } as unknown as IWorktreeService);
  const projection: RuntimeEnvironmentProjection = {
    environmentId,
    purpose: "worktree",
    status: "ready",
    currentRevision: 2,
    stateRevision: 7,
    tools: [],
    updatedAt: "now",
  };
  const calls: { method: string; params: unknown }[] = [];
  const operation = {
    operationId: "c".repeat(32),
    requestId: "request",
    environmentId,
    status: "succeeded" as const,
    stage: "ready" as const,
    cancelRequested: false,
    createdAt: "now",
    updatedAt: "now",
  };
  const raw = {
    get: async (params: unknown) => {
      calls.push({ method: "get", params });
      return projection;
    },
    snapshot: async (params: RuntimeEnvironmentScope) => {
      calls.push({ method: "snapshot", params });
      return {
        protocolVersion: 1,
        scope: { workspacePath: params.workspacePath },
        stateRevision: 7,
        environment: projection,
      };
    },
    reconcile: async (params: unknown) => {
      calls.push({ method: "reconcile", params });
      return { operation, environment: projection };
    },
    resourceSummary: async (params: unknown) => {
      calls.push({ method: "resourceSummary", params });
      return { environmentId, stateRevision: 7, summary: { status: "complete" } };
    },
    startService: async (params: unknown) => {
      calls.push({ method: "startService", params });
      return { status: "started" };
    },
    stopService: async (params: unknown) => {
      calls.push({ method: "stopService", params });
      return { status: "stopped" };
    },
    release: async (params: unknown) => {
      calls.push({ method: "release", params });
      return { status: "released" };
    },
    garbageCollect: async (params: unknown) => {
      calls.push({ method: "garbageCollect", params });
      return {
        operationId: "gc",
        status: "succeeded",
        deletedEntries: 0,
        protectedEntries: 0,
        summary: { status: "complete" },
      };
    },
  } as unknown as IRuntimeEnvironmentHostService;
  const facade = createPublicRuntimeEnvironmentService(raw, {
    worktrees,
    mapBindingScope: true,
    ...(attachment ? { attachmentScope: origin } : {}),
    prepareOverride: async (params, ownerBinding) => {
      assert.equal(ownerBinding.id, binding.id);
      calls.push({ method: "prepare", params });
      return operation;
    },
  });
  const server = ProxyChannel.fromService(facade);
  const service = ProxyChannel.toService<IRuntimeEnvironmentService>({
    call: (method, args) => server.call(undefined, method, args),
    listen: (event, args) => server.listen(undefined, event, args),
  });
  return { origin, execution, binding, environmentId, service, listScopes, calls };
}

for (const attachment of [false, true]) {
  test(`${attachment ? "attachment replayable" : "local continuous"} runtime RPC sends only workspace scope to strict worktree lookup`, async () => {
    const f = fixture(attachment);
    const target = { ...f.execution, environmentId: f.environmentId };
    const budget = { maxEntries: 20, maxDurationMs: 50 };
    const snapshot = await f.service.snapshot(target);
    assert.deepEqual(snapshot.scope, f.execution);
    assert.equal(snapshot.environment?.status, "ready");
    await f.service.get(target);
    await f.service.prepare({
      ...target,
      bindingId: f.binding.id,
      requestId: "request",
      purpose: "worktree",
      operation: "upgrade",
      expectedRevision: 2,
      expectedManifestDigest: "digest",
    });
    await f.service.reconcile({ ...f.execution, requestId: "request" });
    await f.service.resourceSummary({ ...target, requestId: "scan", budget });
    for (const action of ["startService", "stopService"] as const)
      await f.service[action]({
        ...target,
        requestId: action,
        serviceId: "dev:web",
        expectedRevision: 2,
        expectedGeneration: 1,
      });
    await f.service.release({
      ...target,
      requestId: "release",
      expectedRevision: 2,
      reason: "consumer-release",
    });
    await f.service.garbageCollect({ ...f.execution, requestId: "gc", budget, dryRun: true });
    assert.ok(f.listScopes.length >= 9);
    assert.ok(
      f.listScopes.every(
        (scope) => Object.keys(scope).sort().join(",") === "workspaceIdentity,workspacePath",
      ),
    );
    assert.ok(
      f.listScopes.every(
        (scope) =>
          scope.workspaceIdentity ===
          (attachment ? f.origin.workspaceIdentity : f.execution.workspaceIdentity),
      ),
    );
    assert.equal(f.calls.length, 9);
    const storage = f.calls.find(({ method }) => method === "snapshot")!
      .params as RuntimeEnvironmentScope;
    assert.equal(storage.workspacePath, f.binding.checkoutPath);
    assert.equal(storage.workspaceIdentity, undefined);
  });

  test(`${attachment ? "attachment" : "local"} scope projection keeps foreign identity and environment guards`, async () => {
    const f = fixture(attachment);
    for (const target of [
      { ...f.execution, workspaceIdentity: "foreign", environmentId: f.environmentId },
      { ...f.execution, environmentId: "d".repeat(32) },
    ])
      await assert.rejects(f.service.snapshot(target), /scope-mismatch/);
    assert.equal(f.calls.length, 0);
  });
}
