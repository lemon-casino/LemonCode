import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  lcodeProtocolMethods as methods,
  type WorktreeExecutionBinding,
  type RuntimeEnvironmentResolveContextResult,
} from "@lcode/shared";
import type { IWorktreeService } from "../worktree/contract.js";
import { createRuntimeEnvironmentStore } from "../runtime-environment/adapters/store.js";
import { createRuntimeConsumerAuthority } from "../runtime-environment/app/consumerLifecycle.js";
import { createRuntimeEnvironmentServiceForTests } from "../runtime-environment/node.js";
import {
  createRuntimeEnvironmentClient,
  handleRuntimeEnvironmentPublicRequest,
  readRuntimeEnvironmentProtocolCapability,
  isRuntimeEnvironmentRequest,
} from "./runtimeEnvironmentRequests.js";
import { createWorktreeEnvironmentRelease } from "../runtime-environment/app/worktreeRelease.js";
import type { RuntimeConsumerProcessOwner } from "../runtime-environment/contract.js";

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "lcode-env-client-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const checkout = join(dir, "checkout 空格");
  await mkdir(join(checkout, "src"), { recursive: true });
  const store = createRuntimeEnvironmentStore(join(dir, "data"));
  const service = createRuntimeEnvironmentServiceForTests({
    store,
    declarations: {
      read: async () => ({ tools: [], lockfiles: [], ambiguousLocks: false, issues: [] }),
    },
    backend: {
      ensureBackend: async () => "unused",
      probeBackend: async () => ({ available: true }),
      installTool: async ({ key }) => ({ toolPath: join(dir, "tools", key) }),
    },
  });
  const operation = await service.prepare({
    workspacePath: checkout,
    bindingId: "binding",
    requestId: "r",
    purpose: "worktree",
  });
  const environment = await service.get({
    workspacePath: checkout,
    environmentId: operation.environmentId,
  });
  const ref = {
    environmentId: operation.environmentId,
    revision: 1,
    manifestDigest: environment!.manifestDigest!,
  };
  const binding: WorktreeExecutionBinding = {
    id: "binding",
    taskId: "parent",
    requestId: "r",
    workspacePath: checkout,
    originalWorkspacePath: dir,
    repositoryRoot: dir,
    commonDirectory: join(dir, ".git"),
    checkoutPath: checkout,
    branch: "task",
    baseCommit: "a",
    targetBranch: "main",
    sourceFolderPaths: [checkout],
    status: "ready",
    createdAt: "now",
    updatedAt: "now",
    environmentRef: ref,
  };
  const consumers = createRuntimeConsumerAuthority(store, () => new Date().toISOString());
  const calls: unknown[] = [];
  const worktrees = {
    getBinding: async (params: { taskId?: string }) => {
      calls.push(params);
      return ["parent", "child"].includes(params.taskId ?? "") ? binding : null;
    },
  } as unknown as IWorktreeService;
  const create = (clientId: string, processOwner?: RuntimeConsumerProcessOwner) =>
    createRuntimeEnvironmentClient({
      service,
      consumers,
      worktrees,
      workspace: { workspacePath: dir },
      clientId,
      processOwner,
    });
  const request = {
    sessionId: "child",
    executionBindingId: "binding",
    environmentRef: ref,
    cwd: join(checkout, "src"),
    consumer: "app-1",
  };
  const closeRequest = {
    sessionId: request.sessionId,
    executionBindingId: binding.id,
    environmentId: ref.environmentId,
    consumer: request.consumer,
  };
  return {
    dir,
    checkout,
    store,
    consumers,
    service,
    binding,
    ref,
    calls,
    create,
    request,
    closeRequest,
  };
}

test("attached binding authorizes context and exact app cleanup keeps parent and child sessions", async (t) => {
  const f = await fixture(t);
  const client = f.create("client-a");
  assert.ok(isRuntimeEnvironmentRequest(methods.runtimeEnvironmentRetainSession));
  await client.handle(methods.runtimeEnvironmentRetainSession, {
    sessionId: "parent",
    executionBindingId: "binding",
    workspacePath: f.checkout,
    environmentRef: f.ref,
  });
  const result = await client.handle(methods.runtimeEnvironmentResolveContext, f.request);
  assert.equal(JSON.stringify(result).includes("lease"), false);
  assert.equal(JSON.stringify(result).includes("client-a"), false);
  const refs = await f.store.listConsumers(f.ref.environmentId);
  assert.equal(refs.filter((ref) => ref.state === "active").length, 3);
  const repeated = await client.handle(methods.runtimeEnvironmentResolveContext, f.request);
  assert.deepEqual(repeated, result);
  assert.deepEqual(await f.store.listConsumers(f.ref.environmentId), refs);
  assert.deepEqual(await client.handle(methods.runtimeEnvironmentReleaseConsumer, f.closeRequest), {
    removed: 1,
    remaining: 2,
  });
  await client.disposeAfterProcessExit();
  assert.deepEqual(
    (await f.store.listConsumers(f.ref.environmentId))
      .filter((ref) => ref.state === "active")
      .map((ref) => ref.id),
    ["parent", "child"],
  );
});

test("actual runtime owner receipt precedes context and post-exit release failure survives Host restart", async (t) => {
  const f = await fixture(t);
  const owner = {
    runtimeInstanceId: "managed-client-a",
    runtimeGeneration: 3,
    workspacePath: f.dir,
    startedAt: Date.now(),
    pid: 1234,
  };
  const client = f.create("runtime-agent-managed-client-a", owner);
  await client.handle(methods.runtimeEnvironmentResolveContext, f.request);
  const receipts = await f.store.listConsumerOwnerReceipts(f.ref.environmentId);
  assert.equal(receipts.length, 1);
  assert.deepEqual(receipts[0]!.processOwner, owner);
  assert.equal(receipts[0]!.exitConfirmedAt, undefined);
  t.mock.method(f.consumers, "release", async () => {
    throw new Error("fixture consumer persistence failed");
  });
  await assert.rejects(client.disposeAfterProcessExit(), /persistence failed/);
  assert.ok((await f.store.listConsumerOwnerReceipts(f.ref.environmentId))[0]!.exitConfirmedAt);
  t.mock.restoreAll();
  const release = createWorktreeEnvironmentRelease({
    store: f.store,
    stamp: () => new Date().toISOString(),
    stopAll: async () => ({ status: "stopped" }),
    clearRebuildable: async () => {},
    discardResources: async () => {},
  });
  const params = {
    workspacePath: f.checkout,
    environmentId: f.ref.environmentId,
    expectedRevision: f.ref.revision,
    expectedManifestDigest: f.ref.manifestDigest,
    requestId: "discard-original",
    bindingId: f.binding.id,
    intent: "discard" as const,
  };
  await release({ ...params, phase: "fence" });
  assert.equal((await release({ ...params, phase: "stop" })).status, "completed");
  assert.equal(
    (await f.store.listConsumers(f.ref.environmentId)).filter(
      (ref) => ref.kind === "process" && ref.state === "active",
    ).length,
    0,
  );
  assert.equal(
    (await f.store.listConsumers(f.ref.environmentId)).filter(
      (ref) => ref.kind === "session" && ref.state === "active",
    ).length,
    1,
  );
  await client.disposeAfterProcessExit();
});

test("foreign task, binding, revision, remote attachment and injected owner are rejected", async (t) => {
  const f = await fixture(t);
  const client = f.create("client-a");
  for (const patch of [
    { sessionId: "foreign" },
    { executionBindingId: "foreign" },
    { environmentRef: { ...f.ref, revision: 2 } },
    { environmentRef: { ...f.ref, manifestDigest: "wrong-digest" } },
    { environmentRef: { environmentId: "b".repeat(32), revision: 1 } },
    { workspaceIdentity: "foreign" },
    { remoteSessionId: "foreign" },
    { ownerId: "client-b" },
    { lease: "fake" },
  ])
    await assert.rejects(
      client.handle(methods.runtimeEnvironmentResolveContext, { ...f.request, ...patch }),
    );
  assert.deepEqual(await f.store.listConsumers(f.ref.environmentId), []);
});

test("cwd outside the bound checkout, including a symlink escape, cannot acquire", async (t) => {
  const f = await fixture(t);
  const client = f.create("client-a");
  const outside = join(f.dir, "outside");
  await mkdir(outside);
  const link = join(f.checkout, "link");
  await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
  for (const cwd of [outside, link, "relative"]) {
    await assert.rejects(
      client.handle(methods.runtimeEnvironmentResolveContext, { ...f.request, cwd }),
      /scope-mismatch/,
    );
  }
  assert.deepEqual(await f.store.listConsumers(f.ref.environmentId), []);
});

test("two app incarnations coexist; shutdown removes only its client process references", async (t) => {
  const f = await fixture(t);
  const a = f.create("client-a");
  const b = f.create("client-b");
  await a.handle(methods.runtimeEnvironmentResolveContext, f.request);
  await b.handle(methods.runtimeEnvironmentResolveContext, { ...f.request, consumer: "app-2" });
  await a.disposeAfterProcessExit();
  const active = (await f.store.listConsumers(f.ref.environmentId)).filter(
    (ref) => ref.state === "active",
  );
  assert.equal(active.filter((ref) => ref.kind === "session").length, 1);
  assert.equal(active.filter((ref) => ref.kind === "process").length, 1);
  assert.equal(active.find((ref) => ref.kind === "process")?.ownerId, "client-b");
  await assert.rejects(a.handle(methods.runtimeEnvironmentResolveContext, f.request), /exited/);
  await b.disposeAfterProcessExit();
});

test("close before a pending grant settles releases the eventual grant and rejects delivery", async (t) => {
  const f = await fixture(t);
  let resume!: () => void;
  let entered!: () => void;
  const hold = new Promise<void>((done) => {
    resume = done;
  });
  const waiting = new Promise<void>((done) => {
    entered = done;
  });
  const original = f.service.resolveContext.bind(f.service);
  f.service.resolveContext = async (params) => {
    entered();
    await hold;
    return original(params);
  };
  const client = f.create("client-a");
  const resolving = client.handle(methods.runtimeEnvironmentResolveContext, f.request);
  const rejected = assert.rejects(resolving, /closed|exited/);
  await waiting;
  const close = client.disposeAfterProcessExit();
  resume();
  await rejected;
  await close;
  assert.equal(
    (await f.store.listConsumers(f.ref.environmentId)).filter(
      (ref) => ref.kind === "process" && ref.state === "active",
    ).length,
    0,
  );
});

test("digest is checked against the owner even when binding and request both carry the stale digest", async (t) => {
  const f = await fixture(t);
  const expected: unknown[] = [];
  const resolve = f.service.resolveContext.bind(f.service);
  f.service.resolveContext = (params) => {
    expected.push(params.expectedManifestDigest);
    return resolve(params);
  };
  const client = f.create("client-a");
  const result = (await client.handle(
    methods.runtimeEnvironmentResolveContext,
    f.request,
  )) as RuntimeEnvironmentResolveContextResult;
  assert.equal(result.context.manifestDigest, f.ref.manifestDigest);
  assert.deepEqual(expected, [f.ref.manifestDigest]);
  await client.disposeAfterProcessExit();
  f.binding.environmentRef = { ...f.ref, manifestDigest: "stale-digest" };
  await assert.rejects(
    f.create("client-b").handle(methods.runtimeEnvironmentResolveContext, {
      ...f.request,
      consumer: "app-2",
      environmentRef: f.binding.environmentRef,
    }),
    /stale-reference/,
  );
});

test("a foreign release cannot poison an app incarnation before its first acquire", async (t) => {
  const f = await fixture(t);
  const client = f.create("client-a");
  await assert.rejects(
    client.handle(methods.runtimeEnvironmentReleaseConsumer, {
      ...f.closeRequest,
      workspaceIdentity: "foreign",
    }),
    /scope-mismatch/,
  );
  await client.handle(methods.runtimeEnvironmentResolveContext, f.request);
  await client.disposeAfterProcessExit();
});

test("a remote binding keeps execution identity and attachment authorization in the reverse resolver", async (t) => {
  const f = await fixture(t);
  f.binding.originalWorkspaceIdentity = "project-a";
  f.binding.workspaceIdentity = "execution-a";
  const client = createRuntimeEnvironmentClient({
    service: f.service,
    consumers: f.consumers,
    worktrees: { getBinding: async () => f.binding } as unknown as IWorktreeService,
    workspace: {
      workspacePath: f.dir,
      workspaceIdentity: "project-a",
      remoteSessionId: "attachment-a",
    },
    clientId: "client-remote",
  });
  const request = {
    ...f.request,
    workspaceIdentity: "execution-a",
    remoteSessionId: "attachment-a",
  };
  await assert.rejects(
    client.handle(methods.runtimeEnvironmentResolveContext, {
      ...request,
      remoteSessionId: "attachment-b",
    }),
    /scope-mismatch/,
  );
  const result = (await client.handle(
    methods.runtimeEnvironmentResolveContext,
    request,
  )) as RuntimeEnvironmentResolveContextResult;
  assert.equal(result.context.workspaceIdentity, "execution-a");
  await client.disposeAfterProcessExit();
});

test("same path on a foreign attached identity cannot authorize a binding returned by a stale lookup", async (t) => {
  const f = await fixture(t);
  f.binding.originalWorkspaceIdentity = "project-a";
  f.binding.workspaceIdentity = "execution-a";
  const client = f.create("wrong-local-client");
  await assert.rejects(
    client.handle(methods.runtimeEnvironmentResolveContext, {
      ...f.request,
      workspaceIdentity: "execution-a",
    }),
    /scope-mismatch/,
  );
  assert.deepEqual(await f.store.listConsumers(f.ref.environmentId), []);
});

test("public reverse requests route capability and management reads without opening raw cwd resolution", async (t) => {
  const f = await fixture(t);
  const scope = { workspacePath: f.checkout };
  for (const method of [
    methods.runtimeEnvironmentCapabilities,
    methods.runtimeEnvironmentGet,
    methods.runtimeEnvironmentList,
    methods.runtimeEnvironmentSnapshot,
    methods.runtimeEnvironmentReconcile,
  ])
    assert.ok(isRuntimeEnvironmentRequest(method));
  const calls: unknown[] = [];
  const publicService = {
    ...f.service,
    get: async (params: unknown) => {
      calls.push(params);
      return null;
    },
  };
  assert.deepEqual(
    await handleRuntimeEnvironmentPublicRequest(
      methods.runtimeEnvironmentGet,
      { ...scope, environmentId: f.ref.environmentId },
      scope,
      publicService,
    ),
    { environment: null },
  );
  await assert.rejects(
    handleRuntimeEnvironmentPublicRequest(
      methods.runtimeEnvironmentGet,
      { ...scope, workspaceIdentity: "foreign", environmentId: f.ref.environmentId },
      scope,
      publicService,
    ),
    /scope-mismatch/,
  );
  await assert.rejects(
    handleRuntimeEnvironmentPublicRequest(
      methods.runtimeEnvironmentGet,
      { ...scope, cwd: f.checkout, environmentId: f.ref.environmentId },
      scope,
      publicService,
    ),
  );
  assert.equal(calls.length, 1);
  await assert.rejects(
    handleRuntimeEnvironmentPublicRequest(methods.runtimeEnvironmentList, scope, scope, undefined),
    /capability-unavailable/,
  );
  const capability = await readRuntimeEnvironmentProtocolCapability(f.service, scope);
  assert.equal(capability?.managedEnvironments, true);
  assert.equal(capability?.actions?.includes("resolveContext"), true);
  assert.equal(await readRuntimeEnvironmentProtocolCapability(undefined, scope), undefined);
});

test("release and resolve race cannot resurrect a closed incarnation or return a fenced context", async (t) => {
  const f = await fixture(t);
  const client = f.create("client-a");
  await client.handle(methods.runtimeEnvironmentResolveContext, f.request);
  await client.handle(methods.runtimeEnvironmentReleaseConsumer, f.closeRequest);
  await assert.rejects(
    client.handle(methods.runtimeEnvironmentResolveContext, f.request),
    /closed/,
  );
  await f.service.release({
    workspacePath: f.checkout,
    environmentId: f.ref.environmentId,
    requestId: "release",
    expectedRevision: 1,
  });
  await assert.rejects(
    client.handle(methods.runtimeEnvironmentResolveContext, { ...f.request, consumer: "new-app" }),
    /not ready/,
  );
});
