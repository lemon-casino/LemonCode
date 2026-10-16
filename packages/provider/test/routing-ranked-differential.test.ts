import assert from "node:assert/strict";
import test from "node:test";
import { RoutingScheduler, type RoutingCandidate } from "../src/index.js";

test("one logical clock snapshot covers cold ranking and the final planning decision", () => {
  const candidates: RoutingCandidate[] = Array.from({ length: 180 }, (_, i) => ({
    id: `clock${i}`,
    generation: "1",
    portability: "portable",
    quotaGroupId: `p${i}`,
    windows: [
      {
        resourceId: `q${i}`,
        instanceId: "p",
        revision: 1,
        kind: "budget",
        quality: "fresh",
        remaining: 100 + i,
        limit: 1000,
        expiresAt: 150,
      },
    ],
  }));
  let flatClock = 0,
    indexedClock = 0;
  const policy = { version: 1 as const, strategy: "headroom-balance" as const };
  const flat = new RoutingScheduler(policy, { now: () => ++flatClock }),
    indexed = new RoutingScheduler(policy, { now: () => ++indexedClock });
  indexed.setDirectory(
    candidates.map((c) => c.id),
    (id) => candidates[Number(id.slice(5))]!,
  );
  const request = { attemptId: "clock", scopeKey: "scope" };
  const expected = flat.reserve(candidates, request),
    actual = indexed.reserveIndexed(request);
  assert.equal(actual.routeId, expected.routeId);
  expected.cancel();
  actual.cancel();
  flat.dispose();
  indexed.dispose();
});

test("ranked expiry follows comparable units and time boundaries without losing the full planner winner", () => {
  let now = 1;
  const candidates: RoutingCandidate[] = Array.from({ length: 180 }, (_, i) => ({
    id: `e${i}`,
    generation: "1",
    portability: "portable",
    quotaGroupId: `pool${i}`,
    windows: [
      {
        resourceId: `q${i}`,
        instanceId: "p",
        revision: 1,
        kind: "budget",
        quality: "fresh",
        unit: "tokens",
        remaining: 1000,
        limit: 1000,
      },
    ],
    expiry: {
      resourceId: `q${i}`,
      predictedWaste: i + 1,
      expiresAt: 500_000 + i * 30_000,
      comparableUnit: "tokens",
      confidence: "estimated",
    },
  }));
  const policy = { version: 1 as const, strategy: "expiry-first" as const };
  const flat = new RoutingScheduler(policy, { now: () => now }),
    indexed = new RoutingScheduler(policy, { now: () => now });
  indexed.setDirectory(
    candidates.map((c) => c.id),
    (id) => candidates[Number(id.slice(1))]!,
  );
  for (const at of [1, 100_000, 700_000, 1_200_000, 3_000_000, 4_000_000, 6_000_000]) {
    now = at;
    const request = {
      attemptId: String(at),
      scopeKey: "scope",
      tokens: { total: 60, quality: "bound" as const },
    };
    const expected = flat.reserve(candidates, request),
      actual = indexed.reserveIndexed(request);
    assert.equal(actual.routeId, expected.routeId, `now ${at}`);
    expected.cancel();
    actual.cancel();
  }
  flat.dispose();
  indexed.dispose();
});

test("a profile that becomes highly dispersed promotes once and then uses the winner tree", () => {
  const candidates: RoutingCandidate[] = Array.from({ length: 300 }, (_, i) => ({
    id: `p${i}`,
    generation: "1",
    portability: "portable",
    windows: [],
  }));
  const scheduler = new RoutingScheduler({ version: 1, strategy: "reliable-first" });
  scheduler.setDirectory(
    candidates.map((c) => c.id),
    (id) => candidates[Number(id.slice(1))]!,
  );
  const initial = scheduler.reserveIndexed({ attemptId: "initial", scopeKey: "scope" });
  initial.cancel();
  for (let i = 0; i < candidates.length; i++) {
    candidates[i]!.statistics = {
      samples: 8,
      failureRate: 0,
      completionMs: 100,
      marginalCost: i,
      currency: "fixture",
    };
    scheduler.touchDirectory(candidates[i]!.id);
  }
  const next = scheduler.reserveIndexed({ attemptId: "next", scopeKey: "scope" });
  assert.equal(next.routeId, "p0");
  next.cancel();
  assert.equal(scheduler.indexDiagnostics()!.rankBuilds, 1);
  assert.ok(scheduler.indexDiagnostics()!.lastInspected < 32);
  scheduler.dispose();
});

for (const strategy of [
  "reliable-first",
  "primary-backup",
  "share-rotation",
  "headroom-balance",
  "expiry-first",
] as const)
  test(`XQP-10 ranked ${strategy} matches full decisions with changing signals, pools, debt and cache`, () => {
    let now = 1;
    const candidates: RoutingCandidate[] = Array.from({ length: 300 }, (_, i) => ({
      id: `k${i}`,
      generation: "1",
      portability: i % 19 ? "portable" : "account-bound",
      cacheGroupId: `cache-${i % 7}`,
      quotaGroupId: i < 2 ? "together" : `pool${i}`,
      health: i % 17 ? "healthy" : "degraded",
      windows: [
        {
          resourceId: i < 2 ? "shared" : `q${i}`,
          instanceId: "p",
          shared: true,
          revision: 1,
          kind: "budget",
          quality: i % 11 ? "fresh" : "unknown",
          unit: "tokens",
          remaining: 100 + (i % 13) * 50,
          limit: 1000,
        },
      ],
      statistics:
        i % 7
          ? undefined
          : {
              samples: 8,
              failureRate: (i % 3) / 10,
              completionMs: 100 + i * 30,
              ...(i % 4 ? { marginalCost: i, currency: i % 2 ? "A" : "B" } : {}),
            },
      ...(i % 5
        ? {}
        : {
            expiry: {
              resourceId: i < 2 ? "shared" : `q${i}`,
              predictedWaste: i % 37,
              expiresAt: 80_000 + i * 1000,
              confidence: "estimated" as const,
              comparableUnit: i % 2 ? "tokens" : "requests",
            },
          }),
    }));
    const policy = {
      version: 1 as const,
      strategy,
      weights: Object.fromEntries(candidates.map((c, i) => [c.id, (i % 4) + 1])),
      order: candidates.map((c) => c.id).reverse(),
    };
    const flat = new RoutingScheduler(policy, { now: () => now }),
      indexed = new RoutingScheduler(policy, { now: () => now });
    indexed.setDirectory(
      candidates.map((c) => c.id),
      (id) => candidates[Number(id.slice(1))]!,
    );
    for (let i = 0; i < 350; i++) {
      now += 20;
      if (i % 17 === 0) {
        const at = (i * 19) % candidates.length,
          candidate = candidates[at]!;
        candidate.windows[0] = {
          ...candidate.windows[0]!,
          revision: i + 2,
          remaining: i % 34 ? 800 : 100,
        };
        indexed.touchDirectory(candidate.id);
      }
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
        assert.throws(() => indexed.reserveIndexed(request), `iteration ${i}`);
        continue;
      }
      const actual = indexed.reserveIndexed(request);
      assert.equal(actual.routeId, expected.routeId, `iteration ${i}`);
      if (i % 5 === 0) {
        expected.cancel();
        actual.cancel();
        continue;
      }
      expected.dispatch();
      actual.dispatch();
      const window = candidates.find((c) => c.id === actual.routeId)!.windows[0]!;
      const usage = {
        outcome: "success" as const,
        workUnits: total / 2,
        actualDemands: { [window.resourceId]: total / 2 },
        cacheUntil: now + 60_000,
      };
      expected.finish(usage);
      actual.finish(usage);
    }
    assert.ok(indexed.indexDiagnostics()!.rankBuilds > 0);
    indexed.dispose();
    flat.dispose();
  });
