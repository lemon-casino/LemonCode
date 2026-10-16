import assert from "node:assert/strict";
import test from "node:test";
import { RoutingScheduler, type RoutingCandidate, type RoutingStrategy } from "../src/index.js";

test("rotation round advancement considers eligible candidates beyond the display limit", () => {
  const candidates: RoutingCandidate[] = Array.from({ length: 40 }, (_, i) => ({
    id: `debt-${i}`,
    generation: "1",
    portability: "portable",
    windows: [],
  }));
  for (const indexed of [false, true]) {
    const scheduler = new RoutingScheduler({ version: 1, strategy: "share-rotation" });
    for (let i = 0; i < candidates.length; i++) {
      const lease = scheduler.reserve([candidates[i]!], {
        attemptId: `seed-${i}`,
        scopeKey: "seed",
        workUnits: i < 32 ? 40960 : 8192,
      });
      lease.dispatch();
      lease.finish({ outcome: "success" });
    }
    if (indexed)
      scheduler.setDirectory(
        candidates.map((c) => c.id),
        (id) => candidates.find((c) => c.id === id)!,
      );
    const request = { attemptId: "next", scopeKey: "next", workUnits: 1 };
    const lease = indexed
      ? scheduler.reserveIndexed(request)
      : scheduler.reserve(candidates, request);
    assert.equal(lease.routeId, "debt-32");
    lease.cancel();
    scheduler.dispose();
  }
});

for (const strategy of [
  "reliable-first",
  "primary-backup",
  "share-rotation",
  "headroom-balance",
  "expiry-first",
] as RoutingStrategy[])
  test(`indexed ${strategy} matches the full planner across quota, order, work debt and bindings`, () => {
    const candidates: RoutingCandidate[] = Array.from({ length: 80 }, (_, i) => ({
      id: `key-${i}`,
      generation: "1",
      portability: i % 11 ? "portable" : "account-bound",
      health: i % 13 ? "healthy" : "degraded",
      statistics:
        i % 7 ? undefined : { samples: 8, failureRate: (i % 3) / 10, completionMs: 100 + i * 20 },
      windows: [
        {
          resourceId: `quota-${i}`,
          instanceId: "period",
          revision: 1,
          kind: "budget",
          quality: "fresh",
          limit: 1000,
          remaining: [150, 300, 900, 1000][i % 4],
          unit: "tokens",
        },
      ],
      ...(i % 9
        ? {}
        : {
            expiry: {
              resourceId: `quota-${i}`,
              expiresAt: 300_000,
              predictedWaste: 100 + i,
              comparableUnit: "tokens",
              confidence: "estimated" as const,
            },
          }),
    }));
    const policy = {
      version: 1 as const,
      strategy,
      weights: Object.fromEntries(candidates.map((c, i) => [c.id, (i % 4) + 1])),
      order: candidates.map((c) => c.id).reverse(),
    };
    const flat = new RoutingScheduler(policy, { now: () => 1 });
    const indexed = new RoutingScheduler(policy, { now: () => 1 });
    indexed.setDirectory(
      candidates.map((c) => c.id),
      (id) => candidates.find((c) => c.id === id)!,
    );
    for (let i = 0; i < 300; i++) {
      const total = [30, 60, 100, 5000][i % 4]!;
      const request = {
        attemptId: String(i),
        scopeKey: "scope",
        turnId: String(Math.floor(i / 3)),
        workUnits: total,
        tokens: { total, quality: "bound" as const },
      };
      let expected;
      try {
        expected = flat.reserve(candidates, request);
      } catch {
        assert.throws(() => indexed.reserveIndexed(request));
        continue;
      }
      const actual = indexed.reserveIndexed(request);
      assert.equal(actual.routeId, expected.routeId, `iteration ${i}`);
      if (i % 5 === 0) {
        actual.cancel();
        expected.cancel();
        continue;
      }
      actual.dispatch();
      expected.dispatch();
      const feedback = {
        outcome: "success" as const,
        workUnits: total / 2,
        actualDemands: { [`quota-${Number(actual.routeId.slice(4))}`]: total / 2 },
        cacheUntil: 100_000,
      };
      actual.finish(feedback);
      expected.finish(feedback);
    }
    flat.dispose();
    indexed.dispose();
  });

test("indexed attempt identity does not depend on the current cohort representative", () => {
  const scheduler = new RoutingScheduler({ version: 1, strategy: "share-rotation" });
  scheduler.setDirectory(["a", "b"], (id) => ({
    id,
    generation: "1",
    windows: [],
    portability: "portable",
  }));
  const request = { attemptId: "same", scopeKey: "scope" };
  const first = scheduler.reserveIndexed(request);
  assert.throws(
    () => scheduler.reserveIndexed({ ...request, modelKey: "another-model" }),
    /attempt-conflict/,
  );
  assert.equal(scheduler.reserveIndexed(request), first);
  scheduler.setPolicy({ version: 1, strategy: "primary-backup" });
  assert.equal(scheduler.reserveIndexed(request), first);
  assert.throws(() => first.dispatch(), /policy-conflict/);
  scheduler.dispose();
});

test("one private window becoming stale refreshes only its directory entry", () => {
  let now = 0;
  const scheduler = new RoutingScheduler(
    { version: 1, strategy: "headroom-balance" },
    { now: () => now },
  );
  const candidates: RoutingCandidate[] = Array.from({ length: 1000 }, (_, i) => ({
    id: `key-${i}`,
    generation: "1",
    portability: "portable",
    windows: [
      {
        resourceId: `q${i}`,
        instanceId: "p",
        revision: 1,
        kind: "budget",
        quality: "fresh",
        remaining: 100,
        limit: 100,
        unit: "tokens",
        ...(i === 0 ? { resetAt: 10 } : {}),
      },
    ],
  }));
  scheduler.setDirectory(
    candidates.map((c) => c.id),
    (id) => candidates[Number(id.slice(4))]!,
  );
  const first = scheduler.reserveIndexed({ attemptId: "first", scopeKey: "scope" });
  first.cancel();
  const scanned = scheduler.indexDiagnostics()!.scannedKeys;
  now = 11;
  const next = scheduler.reserveIndexed({ attemptId: "next", scopeKey: "scope" });
  assert.notEqual(next.routeId, "key-0");
  assert.equal(scheduler.indexDiagnostics()!.scannedKeys, scanned);
  next.cancel();
  scheduler.dispose();
});
