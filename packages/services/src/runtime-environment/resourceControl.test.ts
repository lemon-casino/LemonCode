import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createRuntimeEnvironmentStore } from "./adapters/store.js";
import { createResourceControl, type ResourcePort } from "./app/resourceControl.js";

const ID = "a".repeat(32);
const AT = "2026-10-06T00:00:00.000Z";
const budget = { maxEntries: 2_000, maxDurationMs: 200 };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "lcode-resource-control-"));
  const store = createRuntimeEnvironmentStore(root);
  const scope = { workspacePath: root, workspaceIdentity: "test-identity" };
  await store.saveEnvironment({ environmentId: ID, scope, status: "ready", purpose: "worktree", currentRevision: 1, createdAt: AT, updatedAt: AT });
  let locked = false;
  let collected: Parameters<ResourcePort["collect"]>[0] | undefined;
  const resources: ResourcePort = {
    ensure: async () => { throw new Error("not used"); },
    clearRebuildable: async () => {},
    scan: async () => { assert.equal(locked, false); return { status: "partial", scanBudget: budget, protectedReferences: 4 }; },
    collect: async (params) => { collected = params; return { operationId: params.operationId, status: "succeeded", deletedEntries: 0,
      protectedEntries: 0, candidates: [], summary: { status: "complete", scanBudget: params.budget } }; },
  };
  const controller = createResourceControl({ store: { ...store, lock: (key, action) => store.lock(key, async () => {
    locked = true; try { return await action(); } finally { locked = false; }
  }), saveEnvironment: async (record) => { assert.equal(locked, true); await store.saveEnvironment(record); } }, resources, stamp: () => AT });
  return { root, store, scope, resources, controller, collected: () => collected, close: () => rm(root, { recursive: true, force: true }) };
}

test("resourceSummary persists partial facts under the environment lock and returns the saved stateRevision", async () => {
  const f = await fixture();
  try {
    const before = await f.store.readEnvironment(ID);
    const result = await f.controller.resourceSummary({ ...f.scope, environmentId: ID, requestId: "scan", budget });
    const saved = await f.store.readEnvironment(ID);
    assert.equal(result.stateRevision, (before?.stateRevision ?? 0) + 1);
    assert.equal(result.stateRevision, saved?.stateRevision);
    assert.deepEqual(result.summary, saved?.resourceSummary);
    assert.equal(result.summary.status, "partial");
    assert.equal(saved?.status, "ready");
    await assert.rejects(f.controller.resourceSummary({ ...f.scope, workspaceIdentity: "another", environmentId: ID, requestId: "scan", budget }), /scope-mismatch/);
  } finally { await f.close(); }
});

test("a scan finishing after an environment change cannot overwrite the newer projection", async () => {
  const f = await fixture();
  try {
    f.resources.scan = async () => {
      await f.store.lock(ID, async () => {
        const record = (await f.store.readEnvironment(ID))!;
        await f.store.saveEnvironment({ ...record, status: "released", updatedAt: AT });
      });
      return { status: "complete", bytes: 0, fileCount: 0 };
    };
    await assert.rejects(f.controller.resourceSummary({ ...f.scope, environmentId: ID, requestId: "stale-scan", budget }), /stale-reference/);
    const saved = await f.store.readEnvironment(ID);
    assert.equal(saved?.status, "released");
    assert.equal(saved?.resourceSummary, undefined);
  } finally { await f.close(); }
});

test("resourceSummary can resolve an omitted environmentId only through the scoped preparation request", async () => {
  const f = await fixture();
  try {
    const { operationIdFor } = await import("./app/ports.js");
    await f.store.saveOperation({ operationId: operationIdFor(f.scope, "prepared"), environmentId: ID, requestId: "prepared", status: "succeeded",
      stage: "ready", cancelRequested: false, createdAt: AT, updatedAt: AT });
    assert.equal((await f.controller.resourceSummary({ ...f.scope, requestId: "prepared", budget })).environmentId, ID);
    await assert.rejects(f.controller.resourceSummary({ ...f.scope, requestId: "unknown", budget }), /stale-reference/);
  } finally { await f.close(); }
});

test("garbageCollect is scoped by identity/request and defaults to dry run; local candidate paths stay internal", async () => {
  const f = await fixture();
  try {
    const params = { ...f.scope, requestId: "gc", budget: { maxEntries: 30_000, maxDurationMs: 3_000 } };
    const result = await f.controller.garbageCollect(params);
    const firstId = result.operationId;
    assert.equal(f.collected()?.dryRun, true);
    assert.deepEqual(f.collected()?.budget, { maxEntries: 20_000, maxDurationMs: 2_000 });
    assert.equal("candidates" in result, false);
    assert.equal((await f.controller.garbageCollect(params)).operationId, firstId);
    const other = await f.controller.garbageCollect({ ...params, workspaceIdentity: "other", dryRun: false });
    assert.notEqual(other.operationId, firstId);
    assert.equal(f.collected()?.dryRun, false);
  } finally { await f.close(); }
});
