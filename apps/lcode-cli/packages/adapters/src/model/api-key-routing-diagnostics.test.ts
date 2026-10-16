import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSharedQuotaCoordinator } from "./api-key-shared-quota.js";
import { ApiKeyPoolRegistry } from "./api-key-pool-registry.js";
import { RoutingError, type SharedQuotaCoordinator } from "@lcode/provider";

test("RCD-10 unavailable shared owners stay unknown and stale pages perform no IO", async () => {
  let reads = 0;
  const registry = new ApiKeyPoolRegistry({
    inspect: async () => {
      reads++;
      throw new RoutingError("quota-owner-unavailable", {
        cause: new Error("synthetic-secret-path"),
      });
    },
  } as unknown as SharedQuotaCoordinator);
  const keys = ["a", "b"].map((id) => ({
    id,
    apiKey: `synthetic-${id}`,
    routing: { quotaPoolId: id },
  }));
  registry.get("fixture", undefined, keys, { version: 1, strategy: "primary-backup" });
  await assert.rejects(
    registry.readRuntimeDiagnostics("fixture", { limit: 2, revision: 99 }),
    /policy-conflict/,
  );
  assert.equal(reads, 0);
  const view = (await registry.readRuntimeDiagnostics("fixture", { limit: 2 }))!;
  assert.equal(reads, 2);
  assert.ok(view.sharedPools.every((pool) => pool.status === "unknown"));
  assert.equal(JSON.stringify(view).includes("synthetic-secret"), false);
  registry.dispose();
});

test("RCD-09 runtime diagnostics distinguish local preview from global held quota without reserving", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "routing-diagnostic-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const coordinator = new FileSharedQuotaCoordinator(directory);
  let reads = 0;
  const inspect = coordinator.inspect.bind(coordinator);
  coordinator.inspect = (...args) => {
    reads++;
    return inspect(...args);
  };
  const registry = new ApiKeyPoolRegistry(coordinator);
  t.after(() => registry.dispose());
  const keys = Object.freeze(
    Array.from({ length: 100000 }, (_, i) => ({
      id: String(i),
      apiKey: `synthetic-secret-${i}`,
      routing: { quotaPoolId: i < 2 ? "team" : `pool-${i}` },
    })),
  );
  registry.get("fixture", undefined, keys, { version: 1, strategy: "share-rotation" });
  registry.observeQuota("fixture", {
    poolId: "team",
    windows: [
      {
        resourceId: "tokens",
        instanceId: "one",
        revision: 1,
        quality: "fresh",
        kind: "budget",
        unit: "tokens",
        limit: 100,
        remaining: 100,
      },
    ],
  });
  const outside = await coordinator.reserve({
    providerId: "fixture",
    poolId: "team",
    keyId: "outside",
    maxInFlight: 8,
    request: {
      attemptId: "outside",
      scopeKey: "private-scope",
      createdAt: Date.now(),
      tokens: { total: 60, quality: "bound" },
    },
    windows: [
      {
        resourceId: JSON.stringify([JSON.stringify(["pool", "team"]), "tokens"]),
        instanceId: "one",
        revision: 1,
        quality: "fresh",
        kind: "budget",
        unit: "tokens",
        limit: 100,
        remaining: 100,
      },
    ],
  });
  const before = registry.readDiagnostics("fixture", { limit: 2 });
  const view = (await registry.readRuntimeDiagnostics("fixture", { limit: 2 }))!;
  assert.equal(reads, 1);
  assert.equal(view.localPreview.items[0]!.windows[0]!.availableSource, "local-preview");
  assert.equal(view.localPreview.items[0]!.windows[0]!.available, 100);
  const resource = view.sharedPools[0]!.view!.resources[0]!;
  assert.equal(resource.available, 40);
  assert.equal(resource.readingRemaining, 100);
  assert.equal(resource.reserved, 60);
  assert.equal(
    resource.held,
    resource.reserved +
      resource.dispatched +
      resource.endedActual +
      resource.endedEstimated +
      resource.folded,
  );
  assert.equal(JSON.stringify(view).includes("synthetic-secret"), false);
  assert.equal(JSON.stringify(view).includes("private-scope"), false);
  assert.deepEqual(registry.readDiagnostics("fixture", { limit: 2 }), before);
  await coordinator.dispatch(outside);
  await coordinator.finish(outside);
  const unknown = (await registry.readRuntimeDiagnostics("fixture", { limit: 1 }))!.sharedPools[0]!
    .view!.resources[0]!;
  assert.equal(unknown.endedEstimated, 60);
  await coordinator.usage(outside, {}, { total: 15 }, { outcome: "success" });
  const actual = (await registry.readRuntimeDiagnostics("fixture", { limit: 1 }))!.sharedPools[0]!
    .view!.resources[0]!;
  assert.equal(actual.endedActual, 15);
  assert.equal(actual.available, 85);
});

test("HD-08 diagnostics bound pool IO concurrency and preserve row order", async () => {
  let active = 0,
    max = 0;
  const registry = new ApiKeyPoolRegistry({
    inspect: async () => {
      active++;
      max = Math.max(max, active);
      await new Promise<void>((done) => setImmediate(done));
      active--;
      throw new RoutingError("quota-owner-unavailable");
    },
  } as unknown as SharedQuotaCoordinator);
  registry.get(
    "fixture",
    undefined,
    Array.from({ length: 12 }, (_, i) => ({
      id: String(i),
      apiKey: "synthetic",
      routing: { quotaPoolId: String(i) },
    })),
  );
  const view = await registry.readRuntimeDiagnostics("fixture", { limit: 12 });
  assert.ok(max <= 4);
  assert.deepEqual(
    view!.sharedPools.map((pool) => pool.poolId),
    Array.from({ length: 12 }, (_, i) => String(i)),
  );
  registry.dispose();
});
