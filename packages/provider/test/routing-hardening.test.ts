import assert from "node:assert/strict";
import test from "node:test";
import { RoutingRecovery } from "../src/routing/recovery.js";
import { RoutingScheduler } from "../src/routing/scheduler.js";
import type { RoutingCandidate } from "@lcode/shared/provider-routing";

test("HD-03 concurrent failures merge longest deadline without duplicate extension or stale probe writes", () => {
  const owner = new RoutingRecovery();
  const a = owner.reserve(["provider"], "a", 0),
    b = owner.reserve(["provider"], "b", 0);
  owner.dispatch(a, 0);
  owner.dispatch(b, 0);
  owner.fail(a, ["provider"], 1000);
  owner.fail(b, ["provider"], 10000);
  assert.equal(owner.retryAt(["provider"]), 10000);
  owner.fail(b, ["provider"], 20000);
  assert.equal(owner.retryAt(["provider"]), 10000);
  const probe = owner.reserve(["provider"], "probe", 10000);
  owner.dispatch(probe, 10000);
  owner.fail(a, ["provider"], 99999);
  owner.finish(probe, "unknown", 10001);
  owner.observe(probe, "success", 10001);
  assert.equal(owner.available(["provider"], 10001), true);
});

test("HD-06 expired nonempty quota admits one exploration until a new reading", () => {
  const owner = new RoutingScheduler(
    { version: 1, strategy: "primary-backup", maxInFlightPerCandidate: 8 },
    { now: () => 11 },
  );
  const route: RoutingCandidate = {
    id: "a",
    generation: "1",
    portability: "portable",
    windows: [
      {
        resourceId: "pool",
        instanceId: "one",
        revision: 1,
        kind: "rate",
        quality: "fresh",
        remaining: 0,
        limit: 100,
        resetAt: 10,
        unit: "requests",
        shared: true,
      },
    ],
  };
  const a = owner.reserve([route], { scopeKey: "a", attemptId: "a" });
  assert.throws(
    () => owner.reserve([{ ...route, id: "b" }], { scopeKey: "b", attemptId: "b" }),
    /concurrency-full|reserve-unverifiable/,
  );
  a.dispatch();
  a.finish({ outcome: "success" });
  assert.throws(
    () => owner.reserve([route], { scopeKey: "c", attemptId: "c" }),
    /reserve-unverifiable|concurrency-full/,
  );
  owner.observeQuota({ ...route.windows[0]!, revision: 2, remaining: 100, resetAt: 100 });
  const next = owner.reserve([route], { scopeKey: "d", attemptId: "d" });
  next.cancel();
  owner.dispose();
});

test("HD-05 completed attempts remain bounded without releasing unconfirmed debits", () => {
  const owner = new RoutingScheduler({ version: 1, strategy: "share-rotation" });
  const routes: RoutingCandidate[] = [
    { id: "a", generation: "1", portability: "portable", windows: [] },
  ];
  for (let i = 0; i < 10000; i++) {
    const lease = owner.reserve(routes, { scopeKey: "scope", attemptId: String(i) });
    lease.dispatch();
    lease.finish({ outcome: "success", workUnits: 1 });
  }
  assert.ok(owner.inspect().attempts <= 4096, JSON.stringify(owner.inspect()));
  owner.dispose();
});

test("HD-05 thousands of recovered identities reclaim tombstones and old permits cannot resurrect failures", () => {
  const state = {};
  const owner = new RoutingRecovery(state);
  for (let i = 0; i < 5000; i++) {
    const key = "key" + i,
      old = owner.reserve([key], "old" + i, 0);
    owner.dispatch(old, 0);
    owner.fail(old, [key], 1);
    owner.finish(old, "failed", 0);
    const probe = owner.reserve([key], "probe" + i, 1);
    owner.dispatch(probe, 1);
    owner.finish(probe, "success", 1);
    owner.fail(old, [key], 99999);
  }
  assert.equal(Object.keys(state).length, 0);
});

test("HD-06 unknown Token bounds are visible as an exclusive exploration rather than zero consumption", () => {
  const owner = new RoutingScheduler({ version: 1, strategy: "primary-backup" });
  const route: RoutingCandidate = {
    id: "a",
    generation: "1",
    portability: "portable",
    windows: [
      {
        resourceId: "unknown",
        instanceId: "one",
        revision: 1,
        kind: "budget",
        quality: "unknown",
        unit: "tokens",
      },
    ],
  };
  const lease = owner.reserve([route], { scopeKey: "s", attemptId: "a" });
  assert.equal(owner.readDiagnostics().resources[0]!.exploration, "reserved");
  assert.equal(owner.readDiagnostics().resources[0]!.available, undefined);
  lease.dispatch();
  assert.equal(owner.readDiagnostics().resources[0]!.exploration, "dispatched");
  lease.finish({ outcome: "success" });
  assert.throws(
    () => owner.reserve([route], { scopeKey: "s", attemptId: "b" }),
    /reserve-unverifiable/,
  );
  owner.dispose();
});
test("HD-07 bounded exploration reports the final cache switch", () => {
  const owner = new RoutingScheduler({ version: 1, strategy: "reliable-first" }, { now: () => 0 });
  const routes: RoutingCandidate[] = [
    {
      id: "a",
      generation: "1",
      portability: "portable",
      statistics: { samples: 8, failureRate: 0, completionMs: 100 },
      windows: [
        {
          resourceId: "a",
          instanceId: "one",
          revision: 1,
          kind: "budget",
          quality: "fresh",
          remaining: 1000,
          limit: 1000,
          unit: "requests",
        },
      ],
    },
    { id: "b", generation: "1", portability: "portable", windows: [] },
  ];
  for (let i = 0; i < 31; i++) {
    const lease = owner.reserve(routes, { scopeKey: "s", attemptId: String(i), turnId: String(i) });
    lease.dispatch();
    lease.finish({ outcome: "success", cacheUntil: 1000 });
  }
  const plan = owner.plan(routes, { scopeKey: "s", attemptId: "next", turnId: "next" });
  assert.equal(plan.routes[0], "b");
  assert.deepEqual(plan.cacheDecision, { action: "switch", reason: "bounded-exploration" });
  owner.dispose();
});

test("HD-06 a verified fresh quota instance clears the prior exploration marker without refunding old usage", () => {
  let now = 11;
  const owner = new RoutingScheduler(
    { version: 1, strategy: "primary-backup" },
    { now: () => now },
  );
  const route: RoutingCandidate = {
    id: "a",
    generation: "1",
    portability: "portable",
    windows: [
      {
        resourceId: "pool",
        instanceId: "old",
        revision: 1,
        kind: "rate",
        quality: "fresh",
        remaining: 0,
        unit: "requests",
        resetAt: 10,
      },
    ],
  };
  const lease = owner.reserve([route], { scopeKey: "s", attemptId: "a" });
  lease.dispatch();
  lease.finish({ outcome: "success" });
  const fresh = {
    ...route.windows[0]!,
    instanceId: "new",
    revision: 1,
    remaining: 100,
    resetAt: 1000,
  };
  owner.observeQuota(fresh);
  assert.equal(
    owner.readDiagnostics().resources.find((r) => r.instanceId === "new")!.exploration,
    undefined,
  );
  assert.equal(owner.readDiagnostics().resources.find((r) => r.instanceId === "old")!.held, 1);
  owner.dispose();
});
