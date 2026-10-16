import assert from "node:assert/strict";
import test from "node:test";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { setImmediate as immediate, setTimeout as pause } from "node:timers/promises";
import { RoutingScheduler } from "../src/routing/scheduler.js";
test(
  "HD-08 100k dispersed routes, nine model profiles and seven-day virtual completed workload remain bounded",
  { timeout: 120000 },
  async (t) => {
    let now = 1;
    const owner = new RoutingScheduler(
      { version: 1, strategy: "headroom-balance" },
      { now: () => now },
    );
    const ids = Array.from({ length: 100000 }, (_, i) => String(i));
    owner.setDirectory(ids, (id) => ({
      id,
      generation: "1",
      portability: "portable",
      statistics: {
        samples: 8,
        failureRate: 0,
        completionMs: 100,
        marginalCost: Number(id) + 1,
        currency: "fixture",
      },
      windows: [
        {
          resourceId: "r" + id,
          instanceId: "one",
          revision: 1,
          kind: "budget",
          quality: "fresh",
          remaining: 1000000 - Number(id),
          limit: 1000000,
          unit: "requests",
        },
      ],
    }));
    const loop = monitorEventLoopDelay({ resolution: 10 });
    loop.enable();
    await pause(20);
    const cold: number[] = [];
    let peakRss = process.memoryUsage().rss;
    for (let model = 0; model < 9; model++) {
      const at = performance.now();
      const input = {
        modelKey: "model" + model,
        scopeKey: "scope",
        attemptId: "cold" + model,
        tokens: { total: model + 1, quality: "bound" as const },
      };
      for (const _ of owner.prepareIndexed(input)) await immediate();
      const lease = owner.reserveIndexed(input);
      lease.cancel();
      cold.push(performance.now() - at);
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
      await immediate();
    }
    assert.ok(owner.indexDiagnostics()!.profileCount <= 2);
    assert.ok(owner.indexDiagnostics()!.rankBuilds >= 9);
    const before = owner.indexDiagnostics()!.scannedKeys,
      elapsed: number[] = [];
    for (let i = 0; i < 10000; i++) {
      now += 60000;
      const at = performance.now();
      const lease = owner.reserveIndexed({
        modelKey: "model8",
        scopeKey: "scope" + i,
        attemptId: "hot" + i,
        tokens: { total: 9, quality: "bound" },
      });
      lease.dispatch();
      lease.finish({
        outcome: "success",
        workUnits: 1,
        actualDemands: { ["r" + lease.routeId]: 1 },
      });
      elapsed.push(performance.now() - at);
      if (i % 32 === 0) {
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
        await immediate();
      }
    }
    assert.equal(owner.indexDiagnostics()!.scannedKeys, before);
    assert.ok(owner.inspect().attempts <= 4096);
    assert.ok(peakRss < 1000 * 1048576, "peak RSS must improve on the old 1452 MiB measurement");
    assert.ok(owner.readDiagnostics().debitRecords <= 4096);
    elapsed.sort((a, b) => a - b);
    await pause(20);
    loop.disable();
    t.diagnostic(
      JSON.stringify({
        scenario: "100k-nine-profiles-virtual-seven-days",
        coldProfileMs: cold,
        hotP95: elapsed[9499],
        maxEventLoopMs: loop.max / 1e6,
        peakRssMiB: peakRss / 1048576,
        heapMiB: process.memoryUsage().heapUsed / 1048576,
        index: owner.indexDiagnostics(),
        attempts: owner.inspect().attempts,
        debitRecords: owner.readDiagnostics().debitRecords,
      }),
    );
    owner.dispose();
  },
);
