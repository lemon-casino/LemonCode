import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type {
  RuntimeConsumerAcquireParams,
  RuntimeConsumerReference,
  RuntimeConsumerReleaseParams,
  RuntimeEnvironmentRecord,
} from "@lcode/shared";
import { createRuntimeEnvironmentStore } from "./adapters/store.js";
import { createRuntimeConsumerAuthority } from "./app/consumerLifecycle.js";

const AT = "2026-10-06T00:00:00.000Z";

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "lcode-consumers-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createRuntimeEnvironmentStore(dir);
  const peer = createRuntimeEnvironmentStore(dir);
  let tick = 0;
  const stamp = () => new Date(Date.parse(AT) + ++tick).toISOString();
  const record: RuntimeEnvironmentRecord = {
    environmentId: "a".repeat(32),
    scope: { workspacePath: join(dir, "checkout 空格"), workspaceIdentity: "scope-a" },
    bindingId: "binding-a",
    purpose: "worktree",
    status: "ready",
    currentRevision: 7,
    createdAt: AT,
    updatedAt: AT,
  };
  await store.saveEnvironment(record);
  return {
    store,
    peer,
    record,
    stamp,
    authority: createRuntimeConsumerAuthority(store, stamp),
    other: createRuntimeConsumerAuthority(peer, stamp),
  };
}

function acquireParams(
  record: RuntimeEnvironmentRecord,
  patch: Partial<RuntimeConsumerAcquireParams> = {},
): RuntimeConsumerAcquireParams {
  return {
    ...record.scope,
    environmentId: record.environmentId,
    revision: record.currentRevision,
    kind: "process",
    id: "app-1",
    ownerId: "client-1",
    ...patch,
  };
}

function releaseParams(
  record: RuntimeEnvironmentRecord,
  ref: RuntimeConsumerReference,
): RuntimeConsumerReleaseParams {
  const { environmentId, kind, id, ownerId, ownerGeneration, lease } = ref;
  return { ...record.scope, environmentId, kind, id, ownerId, ownerGeneration, lease };
}

test("two authorities sharing a dataDir retain every distinct consumer and reuse exact tickets", async (t) => {
  const { store, record, authority, other } = await fixture(t);
  const params = Array.from({ length: 12 }, (_, i) => acquireParams(record, { id: `app-${i}` }));
  const refs = await Promise.all(params.map((p, i) => (i % 2 ? other : authority).acquire(p)));
  assert.equal((await store.listConsumers(record.environmentId)).length, params.length);
  const [first, second] = await Promise.all([
    authority.acquire(params[0]!),
    other.acquire(params[0]!),
  ]);
  assert.deepEqual(first, refs[0]);
  assert.deepEqual(second, first);
  assert.equal(first.ownerGeneration, 1);
  assert.notEqual(first.ownerGeneration, record.currentRevision);
  const restarted = createRuntimeConsumerAuthority(store, () => "2099-01-01T00:00:00.000Z");
  assert.deepEqual(await restarted.acquire(params[0]!), first);
});

test("released tombstones require an explicit previous generation and reject stale tickets", async (t) => {
  const { store, record, authority, other } = await fixture(t);
  const params = acquireParams(record, { expectedOwnerGeneration: 0 });
  const first = await authority.acquire(params);
  const ticket = releaseParams(record, first);
  assert.deepEqual(await other.release(ticket), { removed: 1, remaining: 0 });
  const [tombstone] = await store.listConsumers(record.environmentId);
  assert.ok(tombstone);
  assert.deepEqual(tombstone, { ...first, state: "released", updatedAt: tombstone.updatedAt });
  assert.notEqual(tombstone.updatedAt, first.updatedAt);
  await assert.rejects(authority.acquire(acquireParams(record)), /stale-reference/);
  await assert.rejects(authority.acquire(params), /stale-reference/);
  const replacementParams = acquireParams(record, {
    ownerId: "client-2",
    expectedOwnerGeneration: first.ownerGeneration,
  });
  const second = await other.acquire(replacementParams);
  assert.equal(second.ownerGeneration, first.ownerGeneration + 1);
  assert.notEqual(second.lease, first.lease);
  assert.equal(second.createdAt, first.createdAt);
  assert.deepEqual(await authority.acquire(replacementParams), second);
  const current = releaseParams(record, second);
  for (const stale of [
    ticket,
    { ...current, lease: first.lease },
    { ...current, ownerGeneration: first.ownerGeneration },
    { ...current, ownerId: first.ownerId },
    { ...current, id: "missing" },
    { ...current, kind: "terminal" as const },
  ]) {
    assert.deepEqual(await authority.release(stale), { removed: 0, remaining: 1 });
  }
  assert.deepEqual(await other.release(current), { removed: 1, remaining: 0 });
  assert.deepEqual(await authority.release(current), { removed: 0, remaining: 0 });
});

test("active owners cannot be replaced, revisions are exact, and needsUpdate admits nothing", async (t) => {
  const { store, record, authority } = await fixture(t);
  await assert.rejects(
    authority.acquire(acquireParams(record, { expectedOwnerGeneration: 2 })),
    /stale-reference/,
  );
  const first = await authority.acquire(acquireParams(record));
  await assert.rejects(authority.acquire(acquireParams(record, { ownerId: "foreign" })), /owner/);
  await assert.rejects(
    authority.acquire(acquireParams(record, { revision: 6 })),
    /stale-reference/,
  );
  const newer = { ...record, currentRevision: 8 };
  await store.saveEnvironment(newer);
  await assert.rejects(authority.acquire(acquireParams(newer)), /stale-reference/);
  assert.deepEqual(await store.listConsumers(record.environmentId), [first]);
  await store.saveEnvironment({ ...newer, status: "needsUpdate" });
  await assert.rejects(authority.acquire(acquireParams(newer, { id: "new-app" })), /not ready/);
  await store.saveEnvironment({ ...newer, status: "releasing" });
  await assert.rejects(authority.acquire(acquireParams(newer, { id: "new-app" })), /not ready/);
});

test("scope requires both exact identity and the same lexical platform path", async (t) => {
  const { store, record, authority } = await fixture(t);
  const first = await authority.acquire(acquireParams(record));
  const ticket = releaseParams(record, first);
  const deletion = {
    ...record.scope,
    environmentId: record.environmentId,
    bindingId: "binding-a",
    sessionIds: ["app-1"],
  };
  for (const foreign of [
    { workspaceIdentity: "scope-b" },
    { workspacePath: join(record.scope.workspacePath, "child") },
    { workspacePath: `${record.scope.workspacePath}-other` },
    { workspaceIdentity: undefined },
  ]) {
    await assert.rejects(
      authority.acquire({ ...acquireParams(record), ...foreign }),
      /scope-mismatch/,
    );
    await assert.rejects(authority.release({ ...ticket, ...foreign }), /scope-mismatch/);
    await assert.rejects(
      authority.releaseSessionsAfterDeletion({ ...deletion, ...foreign }),
      /scope-mismatch/,
    );
  }
  const lexical = `${record.scope.workspacePath}/child/..`;
  assert.deepEqual(
    await authority.acquire({
      ...acquireParams(record),
      workspacePath: lexical,
      workspaceIdentity: " scope-a ",
    }),
    first,
  );
  const caseChanged = record.scope.workspacePath.toUpperCase();
  if (process.platform === "win32") {
    assert.deepEqual(
      await authority.acquire({ ...acquireParams(record), workspacePath: caseChanged }),
      first,
    );
  } else {
    await assert.rejects(
      authority.acquire({ ...acquireParams(record), workspacePath: caseChanged }),
      /scope-mismatch/,
    );
  }
  const local = {
    ...record,
    environmentId: "b".repeat(32),
    scope: { workspacePath: record.scope.workspacePath },
  };
  await store.saveEnvironment(local);
  await authority.acquire(acquireParams(local));
  await assert.rejects(
    authority.acquire({ ...acquireParams(local), workspacePath: lexical }),
    /scope-mismatch/,
  );
});

test("strict input validation and unknown or stale releases never write consumer records", async (t) => {
  const { store, record, stamp, authority } = await fixture(t);
  const ref = await authority.acquire(acquireParams(record));
  let writes = 0;
  const guarded = createRuntimeConsumerAuthority(
    {
      ...store,
      saveConsumers: async (id, refs) => {
        writes++;
        await store.saveConsumers(id, refs);
      },
      saveEnvironment: async (value) => {
        writes++;
        await store.saveEnvironment(value);
      },
    },
    stamp,
  );
  const extra = { ...acquireParams(record), lease: "caller-must-not-choose-lease" };
  await assert.rejects(guarded.acquire(extra));
  await assert.rejects(guarded.acquire(acquireParams(record, { environmentId: "../escape" })));
  const ticket = releaseParams(record, ref);
  await assert.rejects(guarded.release({ ...ticket, ownerGeneration: -1 }));
  const untrusted = { ...ticket, revision: 7 };
  await assert.rejects(guarded.release(untrusted));
  const deletion = {
    ...record.scope,
    environmentId: record.environmentId,
    bindingId: "binding-a",
    sessionIds: [],
    extra: true,
  };
  await assert.rejects(guarded.releaseSessionsAfterDeletion(deletion));
  assert.deepEqual(await guarded.release({ ...ticket, id: "unknown" }), {
    removed: 0,
    remaining: 1,
  });
  assert.deepEqual(await guarded.release({ ...ticket, environmentId: "f".repeat(32) }), {
    removed: 0,
    remaining: 0,
  });
  assert.deepEqual(
    await guarded.releaseSessionsAfterDeletion({
      ...record.scope,
      environmentId: "f".repeat(32),
      bindingId: "binding-a",
      sessionIds: ["unknown"],
    }),
    { removed: 0, remaining: 0 },
  );
  assert.equal(writes, 0);
});

test("prepared parent and child sessions share a binding, but deletion keeps every other owner", async (t) => {
  const { store, record, authority, other } = await fixture(t);
  const session = (id: string) =>
    acquireParams(record, { kind: "session", id, ownerId: "binding:binding-a" });
  await assert.rejects(
    authority.acquire({ ...session("child"), ownerId: "binding:other" }),
    /binding/,
  );
  const [parent, child] = await Promise.all([
    authority.acquire(session("parent")),
    other.acquire(session("child")),
  ]);
  assert.deepEqual(await authority.acquire(session("child")), child);
  const processRef = await authority.acquire(acquireParams(record, { id: "child" }));
  const otherTree = {
    ...record,
    environmentId: "b".repeat(32),
    bindingId: "binding-b",
    scope: { ...record.scope, workspacePath: join(record.scope.workspacePath, "new-tree") },
  };
  await store.saveEnvironment(otherTree);
  const otherChild = await authority.acquire(
    acquireParams(otherTree, { kind: "session", id: "child", ownerId: "binding:binding-b" }),
  );
  const deletion = {
    ...record.scope,
    environmentId: record.environmentId,
    bindingId: "binding-a",
    sessionIds: ["child", "child", "missing"],
  };
  await assert.rejects(
    authority.releaseSessionsAfterDeletion({ ...deletion, bindingId: "binding-b" }),
    /binding/,
  );
  assert.deepEqual(await authority.releaseSessionsAfterDeletion(deletion), {
    removed: 1,
    remaining: 2,
  });
  assert.deepEqual(await other.releaseSessionsAfterDeletion(deletion), {
    removed: 0,
    remaining: 2,
  });
  const remaining = (await store.listConsumers(record.environmentId)).filter(
    (ref) => ref.state === "active",
  );
  assert.deepEqual(remaining, [parent, processRef]);
  assert.deepEqual(await store.listConsumers(otherTree.environmentId), [otherChild]);
  assert.deepEqual(await authority.release(releaseParams(otherTree, otherChild)), {
    removed: 1,
    remaining: 0,
  });
  assert.deepEqual(
    (await store.listConsumers(record.environmentId)).filter((ref) => ref.state === "active"),
    remaining,
  );
});
