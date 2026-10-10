import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test, { type TestContext } from "node:test";
import { createRuntimeEnvironmentStore } from "./adapters/store.js";
import { createRuntimeConsumerAuthority } from "./app/consumerLifecycle.js";
import { createWorktreeEnvironmentRelease } from "./app/worktreeRelease.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "lcode-discard-resources-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createRuntimeEnvironmentStore(root);
  const stamp = () => new Date().toISOString();
  const request = {
    workspacePath: root,
    environmentId: "a".repeat(32),
    bindingId: "binding",
    expectedRevision: 1,
    requestId: "discard",
  };
  await store.saveEnvironment({
    environmentId: request.environmentId,
    bindingId: request.bindingId,
    scope: { workspacePath: root },
    purpose: "worktree",
    status: "ready",
    currentRevision: 1,
    createdAt: stamp(),
    updatedAt: stamp(),
  });
  const calls: string[] = [];
  const release = createWorktreeEnvironmentRelease({
    store,
    stamp,
    stopAll: async () => ({ status: "stopped" }),
    clearRebuildable: async () => {
      calls.push("rebuildable");
    },
    discardResources: async () => {
      calls.push("discard");
    },
  });
  return {
    store,
    request,
    calls,
    release,
    authority: createRuntimeConsumerAuthority(store, stamp),
  };
}

test("discard data cleanup waits for exact session deletion; archive only clears rebuildable resources", async (t) => {
  const f = await fixture(t);
  await f.authority.acquire({
    workspacePath: f.request.workspacePath,
    environmentId: f.request.environmentId,
    revision: 1,
    kind: "session",
    id: "session",
    ownerId: "binding:binding",
  });
  const discard = { ...f.request, intent: "discard" as const };
  await f.release({ ...discard, phase: "fence" });
  assert.equal((await f.release({ ...discard, phase: "cleanup" })).status, "releaseBlocked");
  assert.deepEqual(f.calls, []);
  await f.authority.releaseSessionsAfterDeletion({
    workspacePath: f.request.workspacePath,
    environmentId: f.request.environmentId,
    bindingId: f.request.bindingId,
    sessionIds: ["session"],
  });
  await f.release({ ...discard, phase: "cleanup" });
  assert.deepEqual(f.calls, ["discard"]);
  const archived = await fixture(t);
  const archive = { ...archived.request, intent: "archive" as const };
  await archived.release({ ...archive, phase: "fence" });
  await archived.release({ ...archive, phase: "cleanup" });
  assert.deepEqual(archived.calls, ["rebuildable"]);
});

test("logical released state still cleans explicitly discarded private resources and rejects a foreign binding", async (t) => {
  const f = await fixture(t);
  const record = (await f.store.readEnvironment(f.request.environmentId))!;
  await f.store.saveEnvironment({ ...record, status: "released" });
  await f.release({ ...f.request, intent: "discard", phase: "cleanup" });
  assert.deepEqual(f.calls, ["discard"]);
  await assert.rejects(
    f.release({ ...f.request, bindingId: "other", intent: "discard", phase: "cleanup" }),
    /changed/,
  );
  assert.deepEqual(f.calls, ["discard"]);
});

test("an unresolved preparation remains protected even if a legacy record says released", async (t) => {
  const f = await fixture(t);
  const record = (await f.store.readEnvironment(f.request.environmentId))!;
  await f.store.saveEnvironment({
    ...record,
    status: "released",
    activeOperationId: "b".repeat(32),
  });
  assert.equal(
    (await f.release({ ...f.request, intent: "discard", phase: "cleanup" })).status,
    "releaseBlocked",
  );
  assert.deepEqual(f.calls, []);
});
