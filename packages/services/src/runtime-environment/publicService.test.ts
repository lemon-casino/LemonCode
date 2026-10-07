import assert from "node:assert/strict";
import test from "node:test";
import { Emitter, ProxyChannel } from "@lcode/rpc";
import type {
  RuntimeEnvironmentEvent,
  RuntimeEnvironmentProjection,
  WorktreeExecutionBinding,
} from "@lcode/shared";
import type { IRuntimeEnvironmentHostService } from "./contract.js";
import { createPublicRuntimeEnvironmentService } from "./publicService.js";

function fixture() {
  const scope = { workspacePath: "/repo", workspaceIdentity: "project-a" };
  const execution = { workspacePath: "/checkout", workspaceIdentity: "execution-a" };
  const environmentId = "a".repeat(32);
  const projection: RuntimeEnvironmentProjection = {
    environmentId,
    purpose: "worktree",
    status: "ready",
    currentRevision: 2,
    stateRevision: 7,
    tools: [],
    manifestDigest: "digest-a",
    updatedAt: "now",
  };
  const binding = {
    id: "binding-a",
    ...execution,
    checkoutPath: execution.workspacePath,
    originalWorkspacePath: scope.workspacePath,
    originalWorkspaceIdentity: scope.workspaceIdentity,
    environmentRef: { environmentId, revision: 2, manifestDigest: "digest-a" },
    status: "ready",
  } as WorktreeExecutionBinding;
  const calls: { method: string; params: unknown }[] = [];
  const events = new Emitter<RuntimeEnvironmentEvent>();
  const owner = {
    onDidChangeEnvironment: events.event,
    getCapabilities: async () => ({
      managedEnvironments: true,
      protocolVersion: 1,
      actions: ["prepare", "reconcile", "startService", "stopService"],
    }),
    get: async (params: unknown) => {
      calls.push({ method: "get", params });
      return projection;
    },
    list: async (params: unknown) => {
      calls.push({ method: "list", params });
      return [projection];
    },
    snapshot: async (params: unknown) => {
      calls.push({ method: "snapshot", params });
      return {
        protocolVersion: 1,
        scope: { workspacePath: "/checkout" },
        stateRevision: 7,
        environment: projection,
      };
    },
    startService: async (params: unknown) => {
      calls.push({ method: "startService", params });
      return { status: "started" };
    },
    resolveContext: async () => ({
      envOverlay: { set: { SECRET: "private-value" } },
      resourceLeaseToken: "private-token",
    }),
    resolveContextForCwd: async () => ({ resourceLeaseToken: "private-token" }),
  } as unknown as IRuntimeEnvironmentHostService;
  const worktrees = { list: async () => [binding] };
  const service = createPublicRuntimeEnvironmentService(owner, {
    worktrees,
    attachmentScope: scope,
    mapBindingScope: true,
  });
  return {
    scope,
    execution,
    environmentId,
    projection,
    binding,
    calls,
    events,
    owner,
    worktrees,
    service,
  };
}

test("public RPC exposes only management methods, never the trusted resolver or lease", async () => {
  const f = fixture();
  const channel = ProxyChannel.fromService(f.service);
  for (const method of ["resolveContext", "resolveContextForCwd"]) {
    assert.throws(
      () => channel.call(undefined, method, [{ cwd: "/checkout" }]),
      /Method not found/,
    );
    assert.equal(method in f.service, false);
  }
  const result = await f.service.get({ ...f.execution, environmentId: f.environmentId });
  assert.equal(JSON.stringify(result).includes("private-"), false);
});

test("get, list and snapshot authorize the binding before mapping to the owner storage scope", async () => {
  const f = fixture();
  await f.service.get({ ...f.execution, environmentId: f.environmentId });
  assert.deepEqual(await f.service.list(f.scope), [f.projection]);
  const snapshot = await f.service.snapshot({ ...f.execution, environmentId: f.environmentId });
  assert.deepEqual(snapshot.scope, f.execution);
  assert.equal(snapshot.stateRevision, 7);
  assert.equal(snapshot.environment?.stateRevision, 7);
  assert.ok(
    f.calls.every(
      ({ params }) => (params as { workspacePath: string }).workspacePath === "/checkout",
    ),
  );
  assert.ok(f.calls.every(({ params }) => !("workspaceIdentity" in (params as object))));
});

test("same path with another identity or an unrelated environment never reaches the owner", async () => {
  const f = fixture();
  await assert.rejects(
    f.service.list({ ...f.scope, workspaceIdentity: "project-b" }),
    /scope-mismatch/,
  );
  await assert.rejects(
    f.service.snapshot({
      ...f.execution,
      workspaceIdentity: "execution-b",
      environmentId: f.environmentId,
    }),
    /scope-mismatch/,
  );
  await assert.rejects(
    f.service.get({ ...f.scope, environmentId: "b".repeat(32) }),
    /scope-mismatch/,
  );
  await assert.rejects(
    f.service.prepare({ ...f.scope, requestId: "prepare", purpose: "worktree" }),
    /binding/,
  );
  assert.deepEqual(f.calls, []);
});

test("service actions keep exact request and generation while translating only authorized scope", async () => {
  const f = fixture();
  const action = {
    ...f.execution,
    environmentId: f.environmentId,
    serviceId: "web",
    requestId: "start-a",
    expectedRevision: 2,
    expectedGeneration: 3,
  };
  await f.service.startService(action);
  assert.deepEqual(
    f.calls,
    [
      {
        method: "startService",
        params: { ...action, workspacePath: "/checkout", workspaceIdentity: undefined },
      },
    ].map(({ method, params }) => ({
      method,
      params: Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined)),
    })),
  );
});

test("events only invalidate previously authorized environment IDs and never replay a projection", async () => {
  const f = fixture();
  const received: RuntimeEnvironmentEvent[] = [];
  const subscription = f.service.onDidChangeEnvironment!((event) => received.push(event));
  f.events.fire({ environmentId: f.environmentId, stateRevision: 6, kind: "projection.updated" });
  await f.service.snapshot({ ...f.execution, environmentId: f.environmentId });
  f.events.fire({ environmentId: "b".repeat(32), stateRevision: 9, kind: "projection.updated" });
  f.events.fire({
    environmentId: f.environmentId,
    stateRevision: 8,
    kind: "projection.updated",
    projection: f.projection,
  });
  assert.deepEqual(received, [
    { environmentId: f.environmentId, stateRevision: 8, kind: "projection.updated" },
  ]);
  subscription.dispose();
});

test("snapshot rejects a foreign environment or a watermark older than its projection", async () => {
  const f = fixture();
  f.owner.snapshot = async () => ({
    protocolVersion: 1,
    scope: { workspacePath: "/checkout" },
    stateRevision: 6,
    environment: f.projection,
  });
  await assert.rejects(
    f.service.snapshot({ ...f.execution, environmentId: f.environmentId }),
    /stateRevision/,
  );
  f.owner.snapshot = async () => ({
    protocolVersion: 1,
    scope: { workspacePath: "/checkout" },
    stateRevision: 9,
    environment: { ...f.projection, environmentId: "b".repeat(32) },
  });
  await assert.rejects(
    f.service.snapshot({ ...f.execution, environmentId: f.environmentId }),
    /scope-mismatch/,
  );
});

test("prepare uses the worktree lifecycle override rather than bypassing session/binding CAS", async () => {
  const f = fixture();
  const params = {
    ...f.execution,
    bindingId: f.binding.id,
    environmentId: f.environmentId,
    requestId: "upgrade",
    purpose: "worktree" as const,
    operation: "upgrade" as const,
    expectedRevision: 2,
    expectedManifestDigest: "digest-a",
  };
  await assert.rejects(f.service.prepare(params), /capability-unavailable/);
  const received: unknown[] = [];
  const facade = createPublicRuntimeEnvironmentService(f.owner, {
    worktrees: f.worktrees,
    mapBindingScope: true,
    prepareOverride: async (request, binding) => {
      received.push({ request, binding });
      return {
        operationId: "c".repeat(32),
        requestId: request.requestId,
        environmentId: f.environmentId,
        stage: "ready",
        status: "succeeded",
        cancelRequested: false,
        createdAt: "now",
        updatedAt: "now",
      };
    },
  });
  assert.equal((await facade.prepare(params)).status, "succeeded");
  assert.deepEqual(received, [{ request: params, binding: f.binding }]);
  assert.deepEqual(f.calls, []);
});

test("safe public projections remove internal env, lease and unrestricted diagnostic fields", async () => {
  const f = fixture();
  f.owner.get = async () => ({
    ...f.projection,
    envOverlay: { set: { SECRET: "private-env" } },
    resourceLeaseToken: "private-lease",
    error: {
      code: "dependency-install-failed",
      stage: "preparingDependencies",
      message:
        "token=private-token\nAuthorization: Bearer private-bearer\nhttps://user:private-userinfo@example.test/path?token=private-query#private-fragment",
      retryable: true,
      detail: { credential: "private-detail" },
    },
  });
  const result = await f.service.get({ ...f.execution, environmentId: f.environmentId });
  for (const secret of [
    "private-env",
    "private-lease",
    "private-token",
    "private-detail",
    "private-bearer",
    "private-userinfo",
    "private-query",
    "private-fragment",
  ])
    assert.equal(JSON.stringify(result).includes(secret), false);
});

test("relay invalidation remains scoped and a fresh attachment restores only by snapshot", async () => {
  const f = fixture();
  const relay = createPublicRuntimeEnvironmentService(f.service, {
    worktrees: f.worktrees,
    attachmentScope: f.scope,
  });
  const events: RuntimeEnvironmentEvent[] = [];
  const sub = relay.onDidChangeEnvironment!((event) => events.push(event));
  await relay.snapshot({ ...f.execution, environmentId: f.environmentId });
  f.events.fire({
    environmentId: f.environmentId,
    stateRevision: 8,
    kind: "service.updated",
    projection: f.projection,
  });
  assert.deepEqual(events, [
    { environmentId: f.environmentId, stateRevision: 8, kind: "service.updated" },
  ]);
  sub.dispose();
  const resumed = createPublicRuntimeEnvironmentService(f.service, {
    worktrees: f.worktrees,
    attachmentScope: f.scope,
  });
  const afterResume: RuntimeEnvironmentEvent[] = [];
  const resumedSub = resumed.onDidChangeEnvironment!((event) => afterResume.push(event));
  f.events.fire({ environmentId: f.environmentId, stateRevision: 9, kind: "service.updated" });
  assert.deepEqual(afterResume, []);
  assert.equal(
    (await resumed.snapshot({ ...f.execution, environmentId: f.environmentId })).stateRevision,
    7,
  );
  f.events.fire({ environmentId: f.environmentId, stateRevision: 10, kind: "service.updated" });
  assert.deepEqual(afterResume, [
    { environmentId: f.environmentId, stateRevision: 10, kind: "service.updated" },
  ]);
  resumedSub.dispose();
});

test("a public proxy preserves the routed identity instead of mapping it twice", async () => {
  const f = fixture();
  const relay = createPublicRuntimeEnvironmentService(f.service, {
    worktrees: f.worktrees,
    attachmentScope: f.scope,
  });
  const snapshot = await relay.snapshot({ ...f.execution, environmentId: f.environmentId });
  assert.deepEqual(snapshot.scope, f.execution);
  assert.equal(f.calls.length, 1);
});
