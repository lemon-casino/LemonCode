import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { RuntimeEnvironmentRecord } from "@lcode/shared";
import type { RuntimeProcessOwnerObserver } from "./contract.js";
import { createRuntimeEnvironmentStore } from "./adapters/store.js";
import { createRuntimeConsumerAuthority } from "./app/consumerLifecycle.js";
import { createWorktreeEnvironmentRelease } from "./app/worktreeRelease.js";

async function fixture(t: TestContext, observe?: RuntimeProcessOwnerObserver) {
  const root = await mkdtemp(join(tmpdir(), "lcode-upgrade-owner-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createRuntimeEnvironmentStore(join(root, "data"));
  const record: RuntimeEnvironmentRecord = {
    environmentId: "a".repeat(32),
    bindingId: "binding-a",
    scope: { workspacePath: join(root, "checkout") },
    purpose: "worktree",
    status: "ready",
    currentRevision: 1,
    manifestDigest: "manifest-a",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await store.saveEnvironment(record);
  const stamp = () => new Date().toISOString();
  const authority = createRuntimeConsumerAuthority(store, stamp, observe);
  await authority.acquire({
    ...record.scope,
    environmentId: record.environmentId,
    revision: 1,
    kind: "session",
    id: "session-a",
    ownerId: `binding:${record.bindingId}`,
  });
  const ownerScope = { workspacePath: root, workspaceIdentity: "origin-a" };
  const owner = {
    ...ownerScope,
    runtimeInstanceId: "agent-fixture-modern",
    runtimeGeneration: 1,
    startedAt: Date.now(),
    pid: 123456789,
  };
  const process = await authority.acquire(
    {
      ...record.scope,
      environmentId: record.environmentId,
      revision: 1,
      kind: "process",
      id: JSON.stringify(["session-a", "33333333-3333-4333-8333-333333333333"]),
      ownerId: `runtime-agent-${owner.runtimeInstanceId}`,
    },
    owner,
  );
  const params = {
    ...record.scope,
    environmentId: record.environmentId,
    bindingId: record.bindingId!,
    requestId: "upgrade-original",
    expectedRevision: 1,
    expectedManifestDigest: record.manifestDigest,
    ownerScope,
    writer: {
      workspacePath: record.scope.workspacePath,
      ownerId: `upgrade:${record.bindingId}:upgrade-original`,
      token: "fixture-writer",
    },
  };
  const lifecycle = createWorktreeEnvironmentRelease({
    store,
    stamp,
    observeProcessOwner: observe,
    stopAll: async () => ({ status: "stopped" }),
    clearRebuildable: async () => {},
    discardResources: async () => {},
  });
  const release = {
    ...record.scope,
    environmentId: record.environmentId,
    bindingId: record.bindingId!,
    requestId: params.requestId,
    expectedRevision: 1,
    expectedManifestDigest: record.manifestDigest,
    intent: "upgrade" as const,
    upgradeOwnerScope: ownerScope,
  };
  await lifecycle({ ...release, phase: "fence" });
  return { root, store, record, authority, owner, process, params, lifecycle, release };
}

test("explicit upgrade recovers a disappeared modern owner after restart while preserving session references", async (t) => {
  let observed = 0;
  const f = await fixture(t, () => {
    observed++;
    return "absent";
  });
  assert.equal((await f.lifecycle({ ...f.release, phase: "stop" })).status, "completed");
  assert.equal(
    (await f.store.listConsumers(f.record.environmentId)).find((x) => x.kind === "process")?.state,
    "active",
  );
  const restarted = createRuntimeConsumerAuthority(
    f.store,
    () => new Date().toISOString(),
    () => {
      observed++;
      return "absent";
    },
  );
  await restarted.retireOrphanedProcessesForUpgrade!(f.params);
  assert.equal(observed, 2);
  const refs = await f.store.listConsumers(f.record.environmentId);
  assert.equal(refs.find((x) => x.kind === "session")?.state, "active");
  assert.equal(refs.find((x) => x.kind === "process")?.state, "released");
  const audit = await f.store.listConsumerRetirements(f.record.environmentId);
  assert.equal(audit[0]?.reason, "confirmed-environment-upgrade");
  assert.equal(audit[0]?.requestId, f.params.requestId);
  assert.equal(audit[0]?.lease, f.process.lease);
  assert.deepEqual(audit[0]?.orphanedOwner?.processOwner, f.owner);
  assert.equal(
    (await f.store.listConsumerOwnerReceipts(f.record.environmentId))[0]?.exitConfirmedAt,
    undefined,
  );
  await restarted.retireOrphanedProcessesForUpgrade!(f.params);
  assert.equal((await f.store.listConsumerRetirements(f.record.environmentId)).length, 1);
});

test("live, unknown, unavailable, foreign and undocumented owners cannot be retired for update", async (t) => {
  for (const observation of ["present", "unknown", undefined] as const) {
    const f = await fixture(t, observation === undefined ? undefined : () => observation);
    assert.equal((await f.lifecycle({ ...f.release, phase: "stop" })).status, "releaseBlocked");
    await assert.rejects(
      f.authority.retireOrphanedProcessesForUpgrade!(f.params),
      /release-blocked/,
    );
    assert.deepEqual(await f.store.listConsumerRetirements(f.record.environmentId), []);
  }
  const f = await fixture(t, () => "absent");
  await assert.rejects(
    f.authority.retireOrphanedProcessesForUpgrade!({
      ...f.params,
      ownerScope: { ...f.params.ownerScope, workspaceIdentity: "foreign" },
    }),
    /release-blocked/,
  );
  await f.store.saveConsumerOwnerReceipts(f.record.environmentId, []);
  assert.equal((await f.lifecycle({ ...f.release, phase: "stop" })).status, "releaseBlocked");
  await assert.rejects(f.authority.retireOrphanedProcessesForUpgrade!(f.params), /release-blocked/);
  assert.deepEqual(await f.store.listConsumerRetirements(f.record.environmentId), []);
});

test("upgrade recovery requires the exact writer, scope, reference and lifecycle fence", async (t) => {
  const f = await fixture(t, () => "absent");
  for (const params of [
    { ...f.params, expectedRevision: 2 },
    { ...f.params, expectedManifestDigest: "stale" },
    { ...f.params, bindingId: "foreign" },
    { ...f.params, workspaceIdentity: "foreign" },
    { ...f.params, writer: { ...f.params.writer, ownerId: "foreign" } },
    { ...f.params, writer: { ...f.params.writer, workspacePath: f.root } },
  ])
    await assert.rejects(
      f.authority.retireOrphanedProcessesForUpgrade!(params),
      /scope-mismatch|stale-reference/,
    );
  await f.store.saveEnvironment({ ...f.record, status: "releasing", fenceIntent: "archive" });
  await assert.rejects(f.authority.retireOrphanedProcessesForUpgrade!(f.params), /release-blocked/);
  assert.deepEqual(await f.store.listConsumerRetirements(f.record.environmentId), []);
});

test("an owner appearing after stop prevents retirement; audit-first recovery is retryable after write failure", async (t) => {
  let present = false;
  const f = await fixture(t, () => (present ? "present" : "absent"));
  assert.equal((await f.lifecycle({ ...f.release, phase: "stop" })).status, "completed");
  present = true;
  await assert.rejects(f.authority.retireOrphanedProcessesForUpgrade!(f.params), /release-blocked/);
  assert.deepEqual(await f.store.listConsumerRetirements(f.record.environmentId), []);
  present = false;
  const save = f.store.saveConsumers.bind(f.store);
  let fails = true;
  t.mock.method(f.store, "saveConsumers", async (...args: Parameters<typeof save>) => {
    if (fails) throw new Error("fixture consumer write interrupted");
    await save(...args);
  });
  await assert.rejects(
    f.authority.retireOrphanedProcessesForUpgrade!(f.params),
    /write interrupted/,
  );
  assert.equal((await f.store.listConsumerRetirements(f.record.environmentId)).length, 1);
  fails = false;
  await f.authority.retireOrphanedProcessesForUpgrade!(f.params);
  assert.equal((await f.store.listConsumerRetirements(f.record.environmentId)).length, 1);
  assert.equal(
    (await f.store.listConsumers(f.record.environmentId)).find((x) => x.kind === "process")?.state,
    "released",
  );
});
