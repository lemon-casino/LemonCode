import assert from "node:assert/strict";
import test from "node:test";
import { RoutingScheduler, type RoutingCandidate, type RoutingWindow } from "../src/index.js";

const quota = (
  id = "weekly",
  remaining = 100,
  extra: Partial<RoutingWindow> = {},
): RoutingWindow => ({
  resourceId: id,
  instanceId: "period-1",
  revision: 1,
  kind: "budget",
  quality: "fresh",
  limit: 100,
  remaining,
  unit: "tokens",
  ...extra,
});
const route = (id: string, windows: RoutingWindow[] = []): RoutingCandidate => ({
  id,
  generation: "1",
  windows,
  portability: "portable",
});
const request = (id: string, demands: Record<string, number> = {}) => ({
  attemptId: id,
  scopeKey: "workspace/session/actor",
  turnId: id,
  workUnits: 10,
  demands,
});
const scheduler = (strategy = "headroom-balance" as const) =>
  new RoutingScheduler({ version: 1, strategy });

test("PRS-010 planning is read-only and deterministic", () => {
  const owner = new RoutingScheduler({ version: 1, strategy: "share-rotation" });
  const candidates = [route("a"), route("b")];
  const before = owner.inspect();
  for (let i = 0; i < 100; i++)
    assert.deepEqual(
      owner.plan(candidates, request("one")),
      owner.plan(candidates, request("one")),
    );
  assert.deepEqual(owner.inspect(), before);
});

test("PRS-049 concurrent reservations cannot allocate the same remaining balance twice", async () => {
  const owner = scheduler();
  const candidates = [route("a", [quota()])];
  const results = await Promise.allSettled(
    [0, 1].map(async (i) => owner.reserve(candidates, request(`r${i}`, { weekly: 60 }))),
  );
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(owner.inspect().reservations, 1);
});

test("PRS-037 accounts sharing an organization window cannot bypass its reservation", () => {
  const owner = scheduler();
  const candidates = [route("a", [quota("organization")]), route("b", [quota("organization")])];
  const first = owner.reserve(candidates, request("one", { organization: 60 }));
  assert.throws(
    () => owner.reserve(candidates, request("two", { organization: 60 })),
    /quota-exhausted/u,
  );
  first.cancel();
  assert.equal(owner.reserve(candidates, request("three", { organization: 60 })).routeId, "a");
});

test("PRS-035 reservation of several windows is all-or-nothing", () => {
  const owner = scheduler();
  assert.throws(() =>
    owner.reserve(
      [route("a", [quota("week"), quota("short", 5)])],
      request("one", { week: 60, short: 10 }),
    ),
  );
  assert.equal(owner.inspect().reservations, 0);
  assert.equal(
    owner.reserve([route("a", [quota("week")])], request("two", { week: 100 })).routeId,
    "a",
  );
});

test("PRS-036 a spent short window cannot be outweighed by ample weekly quota", () => {
  const owner = scheduler();
  const candidates = [
    route("a", [quota("a-week", 80), quota("a-short", 0)]),
    route("b", [quota("b-week", 30), quota("b-short", 50)]),
  ];
  assert.equal(owner.plan(candidates, request("one")).routes[0], "b");
});

test("PRS-051 same attempt is idempotent and conflicting payload cannot reuse a reservation", () => {
  const owner = scheduler();
  const candidates = [route("a", [quota()])];
  const input = request("one", { weekly: 20 });
  const first = owner.reserve(candidates, input);
  assert.equal(owner.reserve(candidates, input), first);
  assert.throws(() => owner.reserve(candidates, { ...input, workUnits: 99 }), /attempt-conflict/u);
  first.dispatch();
  assert.equal(first.dispatch(), false);
  first.finish({ actualDemands: { weekly: 15 }, workUnits: 8 });
  first.finish({ actualDemands: { weekly: 15 }, workUnits: 8 });
  assert.equal(owner.inspect().reservations, 0);
  assert.equal(owner.plan(candidates, request("two")).available.weekly, 85);
});

test("PRS-059 verified coverage retires only included settled consumption", () => {
  const owner = scheduler();
  const lease = owner.reserve([route("a", [quota()])], request("one", { weekly: 40 }));
  lease.dispatch();
  lease.finish({ actualDemands: { weekly: 30 } });
  const reading = quota("weekly", 70, { revision: 2, coversThroughSeq: lease.sequence });
  owner.observeQuota(reading);
  assert.equal(owner.plan([route("a", [reading])], request("two")).available.weekly, 70);
});

test("PRS-060 unverified quota refresh does not erase local consumption", () => {
  const owner = scheduler();
  const lease = owner.reserve([route("a", [quota()])], request("one", { weekly: 40 }));
  lease.dispatch();
  lease.finish({ actualDemands: { weekly: 30 } });
  const reading = quota("weekly", 70, { revision: 2 });
  owner.observeQuota(reading);
  assert.equal(owner.plan([route("a", [reading])], request("two")).available.weekly, 40);
});

test("PRS-061 covered older consumption never erases the next in-flight reservation", () => {
  const owner = scheduler();
  const initial = quota();
  const one = owner.reserve([route("a", [initial])], request("one", { weekly: 40 }));
  one.dispatch();
  one.finish({ actualDemands: { weekly: 30 } });
  const two = owner.reserve([route("a", [initial])], request("two", { weekly: 20 }));
  const reading = quota("weekly", 70, { revision: 2, coversThroughSeq: one.sequence });
  owner.observeQuota(reading);
  assert.equal(owner.plan([route("a", [reading])], request("three")).available.weekly, 50);
  two.cancel();
});

test("PRS-062 late settlement belongs to its original quota period", () => {
  const owner = scheduler();
  const one = owner.reserve([route("a", [quota()])], request("one", { weekly: 40 }));
  one.dispatch();
  const renewed = quota("weekly", 100, { instanceId: "period-2", revision: 2 });
  owner.observeQuota(renewed);
  one.finish({ actualDemands: { weekly: 30 } });
  assert.equal(owner.plan([route("a", [renewed])], request("two")).available.weekly, 100);
});

test("PRS-055 physical completion releases capacity while unknown consumption stays reserved", () => {
  const owner = scheduler();
  const candidates = [route("a", [quota()])];
  const lease = owner.reserve(candidates, request("one", { weekly: 40 }));
  lease.dispatch();
  lease.finish({});
  assert.equal(owner.inspect().reservations, 0);
  assert.equal(owner.plan(candidates, request("two")).available.weekly, 60);
});

test("PRS-052 pre-cancelled requests do not advance shares or allocate resources", () => {
  const owner = scheduler();
  const before = owner.inspect();
  assert.throws(() =>
    owner.reserve([route("a")], { ...request("one"), signal: AbortSignal.abort() }),
  );
  assert.deepEqual(owner.inspect(), before);
});

test("PRS-046 hard reserve cannot be bypassed when consumption cannot be verified", () => {
  const owner = new RoutingScheduler({
    version: 1,
    strategy: "primary-backup",
    reserveRules: [{ resourceId: "weekly", mode: "hard", minRemainingPercent: 20 }],
  });
  assert.throws(
    () => owner.reserve([route("a", [quota()])], request("unknown")),
    /reserve-unverifiable/u,
  );
  assert.throws(
    () => owner.reserve([route("a", [quota()])], request("too-large", { weekly: 81 })),
    /quota-exhausted/u,
  );
});
