import assert from "node:assert/strict";
import test from "node:test";
import { ApiKeyAccessConfig, type ProviderApiKey } from "@lcode/provider";
import { ApiKeyPool, ApiKeyPoolRegistry } from "./api-key-pool.js";

test("100k catalog reuses its index and steady selection never rescans key values", () => {
  let reads = 0;
  const keys = Array.from({ length: 100_000 }, (_, index) => ({
    id: String(index),
    enabled: true,
    get apiKey() {
      reads++;
      return `synthetic-${index}`;
    },
  }));
  const registry = new ApiKeyPoolRegistry();
  const pool = registry.get("large", "save-1", keys);
  const initializedReads = reads;
  assert.equal(registry.primaryKeyFor(keys)?.id, "0");
  const selectedReads = reads;
  for (let index = 0; index < 100; index++) assert.equal(registry.primaryKeyFor(keys)?.id, "0");
  assert.equal(reads, selectedReads);
  assert.equal(registry.get("large", "save-1", keys), pool);
  for (let index = 0; index < 10_000; index++) {
    const lease = pool.reserve();
    assert.equal(lease.key.id, String(index));
    if (index % 2 === 0) lease.observe(401);
    lease.release();
  }
  assert.equal(reads, selectedReads);
  assert.ok(selectedReads >= initializedReads);
  assert.equal(pool.availableCount, 95_000);
  assert.equal(pool.activeLeaseCount, 0);
  registry.dispose();
});

test("frozen access normalizes once and late old-generation failures do not affect new saves or providers", () => {
  const keys: ProviderApiKey[] = [
    { id: "a", apiKey: "synthetic-a", enabled: true },
    { id: "b", apiKey: "synthetic-b", enabled: true },
  ];
  const registry = new ApiKeyPoolRegistry();
  const access = new ApiKeyAccessConfig({ apiKeys: keys });
  Object.freeze(access);
  assert.equal(registry.keysFor(access), registry.keysFor(access));
  const old = registry.get("first", "old", keys);
  const pending = old.reserve();
  const current = registry.get("first", "new", keys);
  const other = registry.get("other", "old", keys);
  pending.observe(403);
  pending.release();
  assert.equal(old.availableCount, 1);
  assert.equal(current.availableCount, 2);
  assert.equal(other.availableCount, 2);
  assert.equal(
    registry.get(
      "first",
      "new",
      keys.map((key) => ({ ...key })),
    ),
    current,
  );
  const lease = current.reserve();
  registry.dispose();
  assert.throws(() => old.reserve(), /disposed/);
  assert.throws(() => current.reserve(), /disposed/);
  lease.release();
  lease.release();
  assert.equal(current.activeLeaseCount, 0);
});

test("all failed keys permit one real probe; server errors do not isolate keys", () => {
  const pool = new ApiKeyPool([{ id: "a", apiKey: "synthetic-a", enabled: true }]);
  const first = pool.reserve();
  first.observe(500);
  assert.equal(pool.availableCount, 1);
  first.observe(403);
  first.release();
  const probe = pool.reserve();
  probe.observe(401);
  assert.equal(probe.canRotate, false);
  probe.release();
  pool.dispose();
});
