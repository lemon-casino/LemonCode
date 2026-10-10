import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { RuntimeEnvironmentRecord, RuntimeConsumerReference } from "@lcode/shared";
import { createRuntimeEnvironmentStore } from "./adapters/store.js";
import { createRuntimeConsumerAuthority } from "./app/consumerLifecycle.js";
import { createWorktreeEnvironmentRelease } from "./app/worktreeRelease.js";

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "lcode-owner-recovery-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createRuntimeEnvironmentStore(dir);
  const record: RuntimeEnvironmentRecord = {
    environmentId: "a".repeat(32),
    scope: { workspacePath: join(dir, "checkout"), workspaceIdentity: "execution-a" },
    bindingId: "binding-a",
    purpose: "worktree",
    status: "ready",
    currentRevision: 1,
    createdAt: "2026-10-09T00:00:00.000Z",
    updatedAt: "2026-10-09T00:00:00.000Z",
  };
  await store.saveEnvironment(record);
  const stamp = () => new Date().toISOString();
  const authority = createRuntimeConsumerAuthority(store, stamp);
  const owner = {
    runtimeInstanceId: "instance-a",
    runtimeGeneration: 1,
    workspacePath: record.scope.workspacePath,
    workspaceIdentity: "execution-a",
    pid: 1234,
    startedAt: Date.now(),
  };
  const params = {
    ...record.scope,
    environmentId: record.environmentId,
    revision: 1,
    kind: "process" as const,
    id: "app-a",
    ownerId: "runtime-agent-instance-a",
  };
  const ticket = (ref: RuntimeConsumerReference) => ({
    ...record.scope,
    environmentId: ref.environmentId,
    kind: ref.kind,
    id: ref.id,
    ownerId: ref.ownerId,
    ownerGeneration: ref.ownerGeneration,
    lease: ref.lease,
  });
  const releaseParams = {
    ...record.scope,
    environmentId: record.environmentId,
    bindingId: record.bindingId!,
    requestId: "delete-original",
    expectedRevision: 1,
    intent: "discard" as const,
  };
  const lifecycle = () =>
    createWorktreeEnvironmentRelease({
      store,
      stamp,
      stopAll: async () => ({ status: "stopped" }),
      clearRebuildable: async () => {},
      discardResources: async () => {},
    });
  return { store, record, authority, owner, params, ticket, releaseParams, lifecycle };
}

test("exit receipt survives consumer write failure and a new Host settles the exact lease", async (t) => {
  const f = await fixture(t);
  const ref = await f.authority.acquire(f.params, f.owner);
  await f.authority.confirmProcessExit!(f.ticket(ref), f.owner);
  t.mock.method(f.store, "saveConsumers", async () => {
    throw new Error("fixture consumer write failed");
  });
  await assert.rejects(f.authority.release(f.ticket(ref)), /write failed/);
  t.mock.restoreAll();
  const releasing = f.lifecycle();
  await releasing({ ...f.releaseParams, phase: "fence" });
  assert.equal((await releasing({ ...f.releaseParams, phase: "stop" })).status, "completed");
  assert.equal((await f.store.listConsumers(ref.environmentId))[0]?.state, "released");
  assert.ok((await f.store.listConsumerOwnerReceipts(ref.environmentId))[0]?.exitConfirmedAt);
});

test("an active receipt and legacy reference still block release; PID absence is not exit proof", async (t) => {
  const f = await fixture(t);
  await f.authority.acquire(f.params, f.owner);
  await f.authority.acquire({ ...f.params, id: "legacy-app", ownerId: "legacy-unknown" });
  const releasing = f.lifecycle();
  await releasing({ ...f.releaseParams, phase: "fence" });
  assert.equal((await releasing({ ...f.releaseParams, phase: "stop" })).status, "releaseBlocked");
  assert.equal(
    (await f.store.listConsumers(f.record.environmentId)).filter((ref) => ref.state === "active")
      .length,
    2,
  );
});

test("stale owner confirmation and foreign identity cannot release a new process incarnation", async (t) => {
  const f = await fixture(t);
  const first = await f.authority.acquire(f.params, f.owner);
  await assert.rejects(
    f.authority.confirmProcessExit!(
      { ...f.ticket(first), workspaceIdentity: "other-identity" },
      f.owner,
    ),
    /scope-mismatch/,
  );
  await assert.rejects(
    f.authority.confirmProcessExit!(f.ticket(first), { ...f.owner, runtimeGeneration: 2 }),
    /stale-reference/,
  );
  await f.authority.confirmProcessExit!(f.ticket(first), f.owner);
  await f.authority.release(f.ticket(first));
  const owner = { ...f.owner, runtimeInstanceId: "instance-b", runtimeGeneration: 2 };
  const next = await f.authority.acquire(
    {
      ...f.params,
      ownerId: "runtime-agent-instance-b",
      expectedOwnerGeneration: first.ownerGeneration,
    },
    owner,
  );
  await f.authority.confirmProcessExit!(f.ticket(first), f.owner);
  const releasing = f.lifecycle();
  await releasing({ ...f.releaseParams, phase: "fence" });
  assert.equal((await releasing({ ...f.releaseParams, phase: "stop" })).status, "releaseBlocked");
  assert.equal((await f.store.listConsumers(next.environmentId))[0]?.lease, next.lease);
  assert.equal((await f.store.listConsumers(next.environmentId))[0]?.state, "active");
});

test("owner receipt persistence failure prevents granting a consumer lease", async (t) => {
  const f = await fixture(t);
  t.mock.method(f.store, "saveConsumerOwnerReceipts", async () => {
    throw new Error("fixture owner write failed");
  });
  await assert.rejects(f.authority.acquire(f.params, f.owner), /owner write failed/);
  assert.deepEqual(await f.store.listConsumers(f.record.environmentId), []);
});

async function legacyFixture(t: TestContext) {
  const f = await fixture(t);
  const params = {
    ...f.params,
    id: JSON.stringify(["hidden", "22222222-2222-4222-8222-222222222222"]),
    ownerId: "runtime-agent-11111111-1111-4111-8111-111111111111",
  };
  await f.authority.acquire({
    ...f.params,
    kind: "session",
    id: "hidden",
    ownerId: `binding:${f.record.bindingId}`,
  });
  await f.authority.acquire(params);
  await f.store.saveEnvironment({ ...f.record, status: "releasing", fenceIntent: "discard" });
  const retirement = {
    ...f.record.scope,
    environmentId: f.record.environmentId,
    bindingId: f.record.bindingId!,
    requestId: "discard-original",
    expectedRevision: 1,
    sessionIds: ["hidden"],
    repositoryRoot: f.record.scope.workspacePath,
    writer: {
      token: "fixture-trusted-writer",
      ownerId: "discard:discard-original",
      workspacePath: f.record.scope.workspacePath,
    },
  };
  return { ...f, retirement };
}

test("legacy retirement requires completed exact session cleanup and preserves scope and writer guards", async (t) => {
  const f = await legacyFixture(t);
  await assert.rejects(
    f.authority.retireLegacyProcessesForDeletion!(f.retirement),
    /settled session deletion/,
  );
  await f.authority.releaseSessionsAfterDeletion({
    ...f.record.scope,
    environmentId: f.record.environmentId,
    bindingId: f.record.bindingId!,
    sessionIds: ["hidden"],
  });
  await assert.rejects(
    f.authority.retireLegacyProcessesForDeletion!({
      ...f.retirement,
      workspaceIdentity: "foreign",
    }),
    /scope-mismatch/,
  );
  await assert.rejects(
    f.authority.retireLegacyProcessesForDeletion!({ ...f.retirement, expectedRevision: 2 }),
    /stale-reference/,
  );
  await assert.rejects(
    f.authority.retireLegacyProcessesForDeletion!({
      ...f.retirement,
      writer: { ...f.retirement.writer, ownerId: "another-operation" },
    }),
    /original discard checkout writer/,
  );
  assert.deepEqual(await f.store.listConsumerRetirements(f.record.environmentId), []);
  assert.equal((await f.authority.retireLegacyProcessesForDeletion!(f.retirement)).removed, 1);
  assert.equal(
    (await f.store.listConsumerRetirements(f.record.environmentId))[0]?.reason,
    "confirmed-worktree-discard",
  );
  assert.deepEqual(await f.store.listConsumerOwnerReceipts(f.record.environmentId), []);
});

test("legacy audit and reference write failures resume the original retirement without inventing exit proof", async (t) => {
  const f = await legacyFixture(t);
  await f.authority.releaseSessionsAfterDeletion({
    ...f.record.scope,
    environmentId: f.record.environmentId,
    bindingId: f.record.bindingId!,
    sessionIds: ["hidden"],
  });
  t.mock.method(f.store, "saveConsumerRetirements", async () => {
    throw new Error("audit write failed");
  });
  await assert.rejects(
    f.authority.retireLegacyProcessesForDeletion!(f.retirement),
    /audit write failed/,
  );
  assert.equal(
    (await f.store.listConsumers(f.record.environmentId)).find((ref) => ref.kind === "process")
      ?.state,
    "active",
  );
  t.mock.restoreAll();
  t.mock.method(f.store, "saveConsumers", async () => {
    throw new Error("reference write failed");
  });
  await assert.rejects(
    f.authority.retireLegacyProcessesForDeletion!(f.retirement),
    /reference write failed/,
  );
  const first = (await f.store.listConsumerRetirements(f.record.environmentId))[0]!;
  t.mock.restoreAll();
  await assert.rejects(
    f.authority.retireLegacyProcessesForDeletion!({
      ...f.retirement,
      requestId: "different-request",
      writer: { ...f.retirement.writer, ownerId: "discard:different-request" },
    }),
    /journal differs/,
  );
  assert.equal((await f.authority.retireLegacyProcessesForDeletion!(f.retirement)).removed, 1);
  assert.deepEqual((await f.store.listConsumerRetirements(f.record.environmentId))[0], first);
});
