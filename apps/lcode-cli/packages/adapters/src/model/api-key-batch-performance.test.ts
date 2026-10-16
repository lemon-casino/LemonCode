import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { ApiKeyPoolRegistry } from "./api-key-pool.js";

test(
  "100k unknown Keys report fallback and retain an indexed hot path",
  { timeout: 30_000 },
  (t) => {
    const registry = new ApiKeyPoolRegistry();
    const keys = Array.from({ length: 100_000 }, (_, i) => ({
      id: `unknown-${i}`,
      apiKey: `synthetic-${i}`,
    }));
    const start = performance.now();
    const pool = registry.get("fixture", "generation", keys, {
      version: 1,
      strategy: "reliable-first",
    });
    const first = pool.reserve({ attemptId: "cold", scopeKey: "unknown", workUnits: 1 });
    first.release();
    const coldMs = performance.now() - start;
    const before = pool.readRoutingDiagnostics({ limit: 1 });
    assert.equal(before.items[0]!.strategy, "share-rotation");
    assert.equal(before.items[0]!.fallbackReason, "signals-unknown");
    const hotStart = performance.now();
    for (let i = 0; i < 100; i++) {
      const lease = pool.reserve({ attemptId: `hot-${i}`, scopeKey: "unknown", workUnits: 1 });
      lease.release();
    }
    const hotTotalMs = performance.now() - hotStart;
    const after = pool.readRoutingDiagnostics({ limit: 1 }).index!;
    assert.equal(after.scannedKeys, before.index!.scannedKeys);
    assert.equal(after.builds, before.index!.builds);
    assert.ok(after.lastInspected < 128);
    t.diagnostic(JSON.stringify({ scenario: "unknown", coldMs, hotTotalMs, index: after }));
    registry.dispose();
  },
);

for (const strategy of [
  "reliable-first",
  "primary-backup",
  "share-rotation",
  "headroom-balance",
  "expiry-first",
] as const) {
  test(
    `AKB-008 100k enhanced ${strategy}: bounded hot selection and unchanged directory`,
    { timeout: 30_000 },
    (t) => {
      const keys = Array.from({ length: 100_000 }, (_, i) => ({
        id: `key-${i}`,
        apiKey: `synthetic-${i}`,
        routing: { quotaPoolId: "team" },
      }));
      const registry = new ApiKeyPoolRegistry();
      const start = performance.now();
      const pool = registry.get("fixture", "generation", keys, { version: 1, strategy });
      pool.observeRoutingQuota({
        poolId: "team",
        windows: [
          {
            resourceId: "tokens",
            instanceId: "period",
            revision: 1,
            unit: "tokens",
            kind: "budget",
            quality: "fresh",
            remaining: 1_000_000,
            limit: 1_000_000,
          },
        ],
      });
      const request = (i: number) => ({
        attemptId: `attempt-${i}`,
        scopeKey: "scope",
        turnId: `turn-${i}`,
        workUnits: 60,
        tokens: { input: 40, output: 20, total: 60, quality: "bound" as const },
      });
      const first = pool.reserve(request(0));
      first.begin!();
      first.end!(true);
      first.release();
      const cold = performance.now() - start;
      const before = pool.readRoutingDiagnostics({ limit: 1 }).index!;
      const elapsed: number[] = [];
      for (let i = 1; i <= 100; i++) {
        const begin = performance.now();
        const lease = pool.reserve(request(i));
        lease.begin!();
        lease.end!(true);
        lease.release();
        elapsed.push(performance.now() - begin);
      }
      const after = pool.readRoutingDiagnostics({ limit: 1 }).index!;
      assert.equal(after.catalogSize, 100_000);
      assert.equal(after.builds, before.builds, "hot attempts must not rebuild the directory");
      assert.equal(
        after.scannedKeys,
        before.scannedKeys,
        "hot attempts must not traverse the Key list",
      );
      assert.ok(after.lastInspected <= 128, `inspected ${after.lastInspected}`);
      elapsed.sort((a, b) => a - b);
      assert.ok(elapsed[94]! < 50, `hot p95=${elapsed[94]}`);
      assert.ok(cold < 15_000, `cold=${cold}`);
      t.diagnostic(JSON.stringify({ strategy, coldMs: cold, hotP95: elapsed[94], index: after }));
      registry.dispose();
    },
  );
}

test(
  "AKB-010 an exhausted shared pool rejects 100k members without scanning them",
  { timeout: 30_000 },
  () => {
    const registry = new ApiKeyPoolRegistry();
    const pool = registry.get(
      "fixture",
      "generation",
      Array.from({ length: 100_000 }, (_, i) => ({
        id: `k${i}`,
        apiKey: `synthetic-${i}`,
        routing: { quotaPoolId: "team" },
      })),
      { version: 1, strategy: "share-rotation" },
    );
    pool.observeRoutingQuota({
      poolId: "team",
      windows: [
        {
          resourceId: "tokens",
          instanceId: "p",
          revision: 1,
          unit: "tokens",
          kind: "budget",
          quality: "fresh",
          remaining: 60,
          limit: 60,
        },
      ],
    });
    const req = (id: string) => ({
      attemptId: id,
      scopeKey: "scope",
      tokens: { input: 40, output: 20, total: 60, quality: "bound" as const },
    });
    const lease = pool.reserve(req("first"));
    lease.begin!();
    const before = pool.readRoutingDiagnostics({ limit: 1 }).index!;
    assert.throws(() => pool.reserve(req("reject")), /quota-exhausted/);
    const after = pool.readRoutingDiagnostics({ limit: 1 }).index!;
    assert.equal(after.scannedKeys, before.scannedKeys);
    assert.ok(after.lastInspected < 100);
    lease.end!(true);
    lease.release();
    registry.dispose();
  },
);

test(
  "100k independent Keys with different windows retain an indexed hot path and paginated diagnostics",
  { timeout: 30_000 },
  (t) => {
    const registry = new ApiKeyPoolRegistry();
    const keys = Array.from({ length: 100_000 }, (_, i) => ({
      id: `k${i}`,
      apiKey: `synthetic-${i}`,
    }));
    const start = performance.now();
    const pool = registry.get("fixture", "generation", keys, {
      version: 1,
      strategy: "headroom-balance",
      order: keys.map((key) => key.id).reverse(),
    });
    for (let i = 0; i < keys.length; i++)
      pool.observeRoutingQuota({
        keyId: keys[i]!.id,
        windows: [
          {
            resourceId: "tokens",
            instanceId: "p",
            revision: 1,
            kind: "budget",
            quality: "fresh",
            unit: "tokens",
            remaining: 100 + (i % 16) * 50,
            limit: 1000,
          },
        ],
      });
    const request = (id: string) => ({
      attemptId: id,
      scopeKey: "scope",
      tokens: { total: 60, quality: "bound" as const },
    });
    const first = pool.reserve(request("cold"));
    first.release();
    const cold = performance.now() - start;
    const before = pool.readRoutingDiagnostics({ limit: 1 }).index!;
    const hotStart = performance.now();
    for (let i = 0; i < 100; i++) {
      const lease = pool.reserve(request(`hot-${i}`));
      lease.release();
    }
    const hot = performance.now() - hotStart;
    pool.observeRoutingQuota({
      keyId: "k0",
      windows: [
        {
          resourceId: "tokens",
          instanceId: "p",
          revision: 2,
          kind: "budget",
          quality: "fresh",
          unit: "tokens",
          remaining: 1000,
          limit: 1000,
        },
      ],
    });
    const changed = pool.reserve(request("update"));
    assert.equal(changed.key.id, "k0");
    changed.release();
    const after = pool.readRoutingDiagnostics({ limit: 1 }).index!;
    assert.equal(after.scannedKeys, before.scannedKeys);
    assert.equal(after.builds, before.builds);
    assert.ok(after.lastInspected < 128);
    assert.ok(hot < 5000, `100 hot attempts took ${hot}ms`);
    t.diagnostic(JSON.stringify({ coldMs: cold, hotTotalMs: hot, index: after }));
    registry.dispose();
  },
);
