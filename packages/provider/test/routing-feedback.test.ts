import assert from "node:assert/strict";
import test from "node:test";
import { RoutingScheduler, type RoutingCandidate } from "../src/index.js";
const candidates: RoutingCandidate[] = ["a", "b"].map((id) => ({
  id,
  generation: "1",
  portability: "portable",
  windows: [],
}));
const request = (id: string, workUnits = 4096) => ({
  attemptId: id,
  scopeKey: "scope",
  turnId: id,
  workUnits,
});

test("PRS-020 weighted work converges to a 3:1 share across repeated rounds", () => {
  const owner = new RoutingScheduler({
    version: 1,
    strategy: "share-rotation",
    weights: { a: 3, b: 1 },
  });
  const counts = { a: 0, b: 0 };
  for (let i = 0; i < 80; i++) {
    const lease = owner.reserve(candidates, request(String(i)));
    counts[lease.routeId as "a" | "b"]++;
    lease.dispatch();
    lease.finish({ workUnits: 4096 });
  }
  assert.deepEqual(counts, { a: 60, b: 20 });
});

test("PRS-021 oversized work creates debt instead of permanent starvation", () => {
  const owner = new RoutingScheduler({ version: 1, strategy: "share-rotation" });
  const large = owner.reserve(candidates, request("large", 16384));
  large.dispatch();
  large.finish({ workUnits: 16384 });
  const next: string[] = [];
  for (let i = 0; i < 5; i++) {
    const lease = owner.reserve(candidates, request(`small-${i}`));
    next.push(lease.routeId);
    lease.dispatch();
    lease.finish({ workUnits: 4096 });
  }
  assert.deepEqual(next.slice(0, 3), ["b", "b", "b"]);
  assert(next.includes("a"));
});

test("PRS-056 late SDK usage reconciles one unknown physical completion exactly once", () => {
  const owner = new RoutingScheduler({ version: 1, strategy: "primary-backup" });
  const window = {
    resourceId: "weekly",
    instanceId: "one",
    revision: 1,
    kind: "budget" as const,
    quality: "fresh" as const,
    remaining: 100,
    limit: 100,
    unit: "tokens",
  };
  const routes = [{ ...candidates[0]!, windows: [window] }];
  const lease = owner.reserve(routes, { ...request("one", 40), demands: { weekly: 40 } });
  lease.dispatch();
  lease.finish({});
  lease.observeUsage({ workUnits: 30, actualDemands: { weekly: 30 } });
  lease.observeUsage({ workUnits: 30, actualDemands: { weekly: 30 } });
  assert.equal(owner.plan(routes, request("two")).available.weekly, 70);
  assert.equal(owner.inspect().shares[0]?.[1], 4096 - 30);
});

test("PRS-027 unknown quota is not sorted as unused ahead of a known quota", () => {
  const owner = new RoutingScheduler({ version: 1, strategy: "headroom-balance" });
  const known = {
    ...candidates[1]!,
    windows: [
      {
        resourceId: "b",
        instanceId: "one",
        revision: 1,
        kind: "budget" as const,
        quality: "fresh" as const,
        usedPercent: 20,
      },
    ],
  };
  assert.equal(owner.plan([candidates[0]!, known], request("one")).routes[0], "b");
});

test("PRS-070 reliable selection can leave warm cache for a material latency improvement", () => {
  const owner = new RoutingScheduler({ version: 1, strategy: "reliable-first" }, { now: () => 0 });
  const initial = candidates.map((candidate) => ({
    ...candidate,
    statistics: { samples: 8, failureRate: 0, completionMs: 1000 },
  }));
  const lease = owner.reserve(initial, request("one"));
  lease.dispatch();
  lease.finish({ cacheUntil: 100000 });
  initial[1]!.statistics.completionMs = 200;
  assert.equal(owner.plan(initial, request("two")).routes[0], "b");
});

test("PRS-003 invalid work and quota estimates cannot alter reservation state", () => {
  for (const value of [NaN, Infinity, -1]) {
    const owner = new RoutingScheduler({ version: 1, strategy: "primary-backup" });
    assert.throws(() => owner.reserve(candidates, request("bad", value)));
    assert.equal(owner.inspect().reservations, 0);
    assert.throws(() =>
      owner.reserve(candidates, { ...request("bad-demand"), demands: { weekly: value } }),
    );
  }
});
