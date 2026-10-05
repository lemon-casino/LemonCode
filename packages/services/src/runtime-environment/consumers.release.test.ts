import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type {
  ManagedServiceReceipt,
  RuntimeConsumerReference,
  RuntimeEnvironmentRecord,
  RuntimeEnvironmentStatus,
} from "@lcode/shared";
import { createRuntimeEnvironmentStore } from "./adapters/store.js";
import {
  createRuntimeConsumerAuthority,
  releaseRuntimeEnvironment,
} from "./app/consumerLifecycle.js";
import type { RuntimeEnvironmentStore } from "./app/ports.js";

const AT = "2026-10-06T00:00:00.000Z";

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "lcode-consumer-release-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createRuntimeEnvironmentStore(dir);
  const peer = createRuntimeEnvironmentStore(dir);
  const record: RuntimeEnvironmentRecord = {
    environmentId: "a".repeat(32),
    scope: { workspacePath: join(dir, "checkout"), workspaceIdentity: "scope-a" },
    bindingId: "binding-a",
    purpose: "worktree",
    status: "ready",
    currentRevision: 7,
    createdAt: AT,
    updatedAt: AT,
  };
  await store.saveEnvironment(record);
  let tick = 0;
  const stamp = () => new Date(Date.parse(AT) + ++tick).toISOString();
  const params = {
    ...record.scope,
    environmentId: record.environmentId,
    revision: 7,
    kind: "process" as const,
    id: "app-private-id",
    ownerId: "client-private-owner",
  };
  const request = {
    ...record.scope,
    environmentId: record.environmentId,
    requestId: "release",
    expectedRevision: 7,
  };
  const ticket = (ref: RuntimeConsumerReference) => {
    const { environmentId, kind, id, ownerId, ownerGeneration, lease } = ref;
    return { ...record.scope, environmentId, kind, id, ownerId, ownerGeneration, lease };
  };
  return {
    store,
    peer,
    record,
    stamp,
    params,
    request,
    ticket,
    authority: createRuntimeConsumerAuthority(store, stamp),
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** 用真实文件锁建立顺序，不用 sleep 猜测竞态。 */
function holdNextLock(
  store: RuntimeEnvironmentStore,
  entered: ReturnType<typeof deferred>,
  proceed: ReturnType<typeof deferred>,
) {
  return {
    ...store,
    lock: <T>(key: string, action: () => Promise<T>): Promise<T> =>
      store.lock(key, async () => {
        entered.resolve();
        await proceed.promise;
        return action();
      }),
  };
}

test("blocked release fences acquisition, preserves tickets, then releases logically after cleanup", async (t) => {
  const { store, record, authority, stamp, params, request, ticket } = await fixture(t);
  await mkdir(record.scope.workspacePath);
  const file = join(record.scope.workspacePath, "keep.txt");
  await writeFile(file, "not environment reclamation");
  const ref = await authority.acquire(params);
  const statuses: RuntimeEnvironmentStatus[] = [];
  const observed = {
    ...store,
    saveEnvironment: async (value: RuntimeEnvironmentRecord) => {
      statuses.push(value.status);
      await store.saveEnvironment(value);
    },
    listConsumers: async (id: string) => {
      assert.equal((await store.readEnvironment(id))?.status, "releasing");
      return store.listConsumers(id);
    },
  };
  const result = await releaseRuntimeEnvironment(observed, request, stamp);
  assert.equal(result.status, "releaseBlocked");
  assert.deepEqual(statuses, ["releasing", "releaseBlocked"]);
  const blocked = await store.readEnvironment(record.environmentId);
  assert.equal(blocked?.status, "releaseBlocked");
  assert.equal(blocked?.error?.code, "release-blocked");
  assert.equal(blocked?.error?.stage, "releasing");
  assert.equal(blocked?.error?.retryable, true);
  assert.equal(blocked?.error?.detail?.activeConsumers, "1");
  assert.equal(blocked?.error?.message, result.reason);
  assert.ok(result.reason && result.reason.length < 2048);
  for (const secret of [ref.lease, ref.ownerId, ref.id, record.scope.workspacePath]) {
    assert.ok(!JSON.stringify(result).includes(secret));
    assert.ok(!JSON.stringify(blocked?.error).includes(secret));
  }
  assert.deepEqual(await store.listConsumers(record.environmentId), [ref]);
  await assert.rejects(authority.acquire(params), /not ready/);
  assert.deepEqual(await authority.release(ticket(ref)), { removed: 1, remaining: 0 });
  assert.deepEqual(await releaseRuntimeEnvironment(observed, request, stamp), {
    status: "released",
  });
  assert.deepEqual(statuses, ["releasing", "releaseBlocked", "releasing", "released"]);
  const released = await store.readEnvironment(record.environmentId);
  assert.equal(released?.error, undefined);
  assert.deepEqual(await releaseRuntimeEnvironment(observed, request, stamp), {
    status: "released",
  });
  assert.equal(statuses.length, 4);
  assert.deepEqual(await store.readEnvironment(record.environmentId), released);
  assert.equal(await readFile(file, "utf8"), "not environment reclamation");
});

test("release validates scope, strict input and current revision without writing", async (t) => {
  const { store, record, request, stamp } = await fixture(t);
  let writes = 0;
  const observed = {
    ...store,
    saveEnvironment: async (value: RuntimeEnvironmentRecord) => {
      writes++;
      await store.saveEnvironment(value);
    },
  };
  for (const foreign of [
    { workspaceIdentity: "foreign" },
    { workspacePath: join(record.scope.workspacePath, "child") },
  ]) {
    await assert.rejects(
      releaseRuntimeEnvironment(observed, { ...request, ...foreign }, stamp),
      /scope-mismatch/,
    );
  }
  const extra = { ...request, lease: "not-public" };
  await assert.rejects(releaseRuntimeEnvironment(observed, extra, stamp));
  assert.match(
    (await releaseRuntimeEnvironment(observed, { ...request, expectedRevision: 6 }, stamp))
      .reason ?? "",
    /stale-reference/,
  );
  assert.deepEqual(
    await releaseRuntimeEnvironment(observed, { ...request, environmentId: "f".repeat(32) }, stamp),
    { status: "released" },
  );
  assert.equal(writes, 0);
  assert.deepEqual(await store.readEnvironment(record.environmentId), record);
});

test("revision is reread after obtaining the same environment lock", async (t) => {
  const { store, peer, record, request, stamp } = await fixture(t);
  const entered = deferred();
  const proceed = deferred();
  const upgraded = { ...record, currentRevision: 8 };
  const writer = store.lock(record.environmentId, async () => {
    entered.resolve();
    await proceed.promise;
    await store.saveEnvironment(upgraded);
  });
  await entered.promise;
  const pending = releaseRuntimeEnvironment(peer, request, stamp);
  proceed.resolve();
  await writer;
  assert.match((await pending).reason ?? "", /stale-reference/);
  assert.deepEqual(await store.readEnvironment(record.environmentId), upgraded);
});

test("release never claims pending preparation is fenced or settled", async (t) => {
  const { store, record, request, stamp } = await fixture(t);
  for (const status of [
    "allocated",
    "resolvingTools",
    "installingTools",
    "preparingDependencies",
    "cancelling",
  ] as const) {
    const preparing = { ...record, status };
    await store.saveEnvironment(preparing);
    const blocked = await releaseRuntimeEnvironment(store, request, stamp);
    assert.equal(blocked.status, "releaseBlocked");
    assert.match(blocked.reason ?? "", /preparation/);
    assert.deepEqual(await store.readEnvironment(record.environmentId), preparing);
  }
  for (const status of [
    "ready",
    "needsUpdate",
    "failed",
    "cancelled",
    "releasing",
    "releaseBlocked",
  ] as const) {
    await store.saveEnvironment({ ...record, status });
    assert.deepEqual(await releaseRuntimeEnvironment(store, request, stamp), {
      status: "released",
    });
  }
});

test("running, unknown and failed-without-exit service receipts block release", async (t) => {
  const { store, record, request, stamp } = await fixture(t);
  const base: ManagedServiceReceipt = {
    environmentId: record.environmentId,
    revision: 7,
    serviceId: "private-service-id",
    generation: 1,
    state: "running",
    urls: [],
    startedAt: AT,
  };
  for (const state of ["starting", "running", "stopping", "unknown", "failed"] as const) {
    await store.saveEnvironment(record);
    await store.saveServiceReceipt({ ...base, state });
    const result = await releaseRuntimeEnvironment(store, request, stamp);
    assert.equal(result.status, "releaseBlocked");
    assert.match(result.reason ?? "", /0 active consumers, 1 unconfirmed services/);
    assert.ok(!result.reason?.includes(base.serviceId));
    assert.equal(
      (await store.readServiceReceipt(record.environmentId, base.serviceId))?.state,
      state,
    );
  }
  // 索引已知但收据丢失同样无法证明进程退出；其余持久化仍走真实 store。
  assert.equal(
    (
      await releaseRuntimeEnvironment(
        { ...store, readServiceReceipt: async () => null },
        request,
        stamp,
      )
    ).status,
    "releaseBlocked",
  );
  for (const state of ["stopped", "failed"] as const) {
    await store.saveServiceReceipt({ ...base, state, stoppedAt: AT });
    assert.equal((await releaseRuntimeEnvironment(store, request, stamp)).status, "released");
    await store.saveEnvironment(record);
  }
});

test("consumer release beats a delayed registration without reviving its tombstone", async (t) => {
  const { store, peer, record, stamp, params, ticket, authority } = await fixture(t);
  const ref = await authority.acquire(params);
  const entered = deferred();
  const proceed = deferred();
  const releasing = createRuntimeConsumerAuthority(holdNextLock(store, entered, proceed), stamp);
  const release = releasing.release(ticket(ref));
  await entered.promise;
  const acquire = createRuntimeConsumerAuthority(peer, stamp).acquire(params);
  const rejected = assert.rejects(acquire, /stale-reference/);
  proceed.resolve();
  assert.deepEqual(await release, { removed: 1, remaining: 0 });
  await rejected;
  assert.equal((await store.listConsumers(record.environmentId))[0]?.state, "released");
});

test("acquisition beats environment release and is counted before the fence settles", async (t) => {
  const { store, peer, record, stamp, params, request, ticket, authority } = await fixture(t);
  const entered = deferred();
  const proceed = deferred();
  const acquiring = createRuntimeConsumerAuthority(holdNextLock(store, entered, proceed), stamp);
  const pending = acquiring.acquire(params);
  await entered.promise;
  const release = releaseRuntimeEnvironment(peer, request, stamp);
  proceed.resolve();
  const ref = await pending;
  assert.equal((await release).status, "releaseBlocked");
  assert.deepEqual(await store.listConsumers(record.environmentId), [ref]);
  assert.deepEqual(await authority.release(ticket(ref)), { removed: 1, remaining: 0 });
  assert.equal((await releaseRuntimeEnvironment(peer, request, stamp)).status, "released");
});

test("environment release beats concurrent acquisition and cannot resurrect released state", async (t) => {
  const { store, peer, record, stamp, params, request } = await fixture(t);
  const entered = deferred();
  const proceed = deferred();
  const release = releaseRuntimeEnvironment(holdNextLock(store, entered, proceed), request, stamp);
  await entered.promise;
  const acquire = createRuntimeConsumerAuthority(peer, stamp).acquire(params);
  const rejected = assert.rejects(acquire, /not ready/);
  proceed.resolve();
  assert.equal((await release).status, "released");
  await rejected;
  assert.deepEqual(await store.listConsumers(record.environmentId), []);
});
