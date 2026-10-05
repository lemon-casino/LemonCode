import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { lcodeProtocolMethods as methods, type WorktreeExecutionBinding } from "@lcode/shared";
import type { IWorktreeService } from "../worktree/contract.js";
import { createRuntimeEnvironmentStore } from "../runtime-environment/adapters/store.js";
import { createRuntimeConsumerAuthority } from "../runtime-environment/app/consumerLifecycle.js";
import { createRuntimeEnvironmentServiceForTests } from "../runtime-environment/node.js";
import {
  createRuntimeEnvironmentClient,
  isRuntimeEnvironmentRequest,
} from "./runtimeEnvironmentRequests.js";

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
  const ref = { environmentId: operation.environmentId, revision: 1 };
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
  const create = (clientId: string) =>
    createRuntimeEnvironmentClient({
      service,
      consumers,
      worktrees,
      workspace: { workspacePath: dir },
      clientId,
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

test("foreign task, binding, revision, remote attachment and injected owner are rejected", async (t) => {
  const f = await fixture(t);
  const client = f.create("client-a");
  for (const patch of [
    { sessionId: "foreign" },
    { executionBindingId: "foreign" },
    { environmentRef: { ...f.ref, revision: 2 } },
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
