import assert from "node:assert/strict";
import test from "node:test";
import { RoutingScheduler, type RoutingCandidate } from "../src/index.js";

for (const strategy of [
  "reliable-first",
  "primary-backup",
  "share-rotation",
  "headroom-balance",
  "expiry-first",
] as const)
  test(
    `XQP-09 ${strategy}: 100k distinct pools use incremental ranked selection`,
    { timeout: 60_000 },
    (t) => {
      const candidates: RoutingCandidate[] = Array.from({ length: 100_000 }, (_, i) => ({
        id: `key-${i}`,
        generation: "1",
        portability: "portable",
        quotaGroupId: `pool-${i}`,
        statistics: {
          samples: 8,
          failureRate: (i % 9) / 100,
          completionMs: 100 + i,
          marginalCost: i,
          currency: "fixture",
        },
        windows: [
          {
            resourceId: `q-${i}`,
            instanceId: "period",
            shared: true,
            revision: 1,
            unit: "tokens",
            kind: "budget",
            quality: "fresh",
            remaining: 100 + (i % 900),
            limit: 1000,
          },
        ],
        expiry: {
          resourceId: `q-${i}`,
          predictedWaste: i % 100,
          expiresAt: 100_000 + i,
          comparableUnit: "tokens",
          confidence: "estimated",
        },
      }));
      const scheduler = new RoutingScheduler({ version: 1, strategy }, { now: () => 1 });
      const start = performance.now();
      scheduler.setDirectory(
        candidates.map((c) => c.id),
        (id) => candidates[Number(id.slice(4))]!,
      );
      const request = (i: number) => ({
        attemptId: String(i),
        scopeKey: "scope",
        workUnits: 1,
        tokens: { total: 1, quality: "bound" as const },
      });
      const cold = scheduler.reserveIndexed(request(0));
      cold.cancel();
      const coldMs = performance.now() - start;
      const before = scheduler.indexDiagnostics()!;
      const elapsed: number[] = [];
      for (let i = 1; i <= 50; i++) {
        const at = performance.now();
        const lease = scheduler.reserveIndexed(request(i));
        lease.cancel();
        elapsed.push(performance.now() - at);
      }
      const after = scheduler.indexDiagnostics()!;
      assert.equal(after.scannedKeys, before.scannedKeys);
      assert.ok(after.refreshedKeys - before.refreshedKeys <= 200);
      assert.ok(after.lastInspected <= 32, `selected ${after.lastInspected} candidates`);
      elapsed.sort((a, b) => a - b);
      assert.ok(elapsed[47]! < 25, `hot p95=${elapsed[47]}`);
      t.diagnostic(JSON.stringify({ strategy, coldMs, hotP95: elapsed[47], index: after }));
      scheduler.dispose();
    },
  );
