import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiKeyPoolRegistry } from "./api-key-pool.js";
import { FileSharedQuotaCoordinator } from "./api-key-shared-quota.js";

test(
  "100k API Keys in distinct pools: indexed selection plus real shared-owner IO stays bounded",
  { timeout: 60_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "lcode-quota-dispersed-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const registry = new ApiKeyPoolRegistry(new FileSharedQuotaCoordinator(directory));
    const start = performance.now();
    const keys = Array.from({ length: 100_000 }, (_, i) => ({
      id: `k${i}`,
      apiKey: `synthetic-${i}`,
      routing: { quotaPoolId: `pool${i}` },
    }));
    const pool = registry.get("fixture", "generation", keys, {
      version: 1,
      strategy: "headroom-balance",
    });
    for (let i = 0; i < keys.length; i++)
      pool.observeRoutingQuota({
        poolId: `pool${i}`,
        windows: [
          {
            resourceId: "tokens",
            instanceId: "p",
            revision: 1,
            kind: "budget",
            quality: "fresh",
            unit: "tokens",
            remaining: 1000 - (i % 100),
            limit: 1000,
          },
        ],
      });
    const request = (i: number) => ({
      attemptId: String(i),
      scopeKey: "scope",
      workUnits: 1,
      tokens: { total: 1, quality: "bound" as const },
    });
    const cold = await pool.acquire(undefined, undefined, request(0));
    cold.release();
    await cold.flushRouting?.();
    const coldMs = performance.now() - start,
      before = pool.readRoutingDiagnostics({ limit: 1 }).index!;
    const elapsed: number[] = [];
    for (let i = 1; i <= 50; i++) {
      const at = performance.now();
      const lease = await pool.acquire(undefined, undefined, request(i));
      lease.release();
      await lease.flushRouting?.();
      elapsed.push(performance.now() - at);
    }
    const after = pool.readRoutingDiagnostics({ limit: 1 }).index!;
    assert.equal(after.scannedKeys, before.scannedKeys);
    assert.equal(after.rankBuilds, 1);
    assert.ok(after.lastInspected <= 32);
    assert.ok(after.refreshedKeys - before.refreshedKeys <= 200);
    const files = (await readdir(directory)).filter((f) => f.endsWith(".json"));
    assert.equal(files.length, 1, "never create files for the unselected 99,999 pools");
    elapsed.sort((a, b) => a - b);
    assert.ok(elapsed[47]! < 100, `hot p95=${elapsed[47]}`);
    t.diagnostic(
      JSON.stringify({ coldMs, hotP95: elapsed[47], index: after, sharedFiles: files.length }),
    );
    await registry.drain();
    registry.dispose();
  },
);
