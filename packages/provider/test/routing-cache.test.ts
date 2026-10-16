import assert from "node:assert/strict";
import test from "node:test";
import { RoutingScheduler, type RoutingCandidate, type RoutingStrategy } from "../src/index.js";

const route = (id: string, used = 20): RoutingCandidate => ({
  id,
  generation: "1",
  portability: "portable",
  windows: [
    {
      resourceId: id,
      instanceId: "week-1",
      revision: 1,
      quality: "fresh",
      kind: "budget",
      limit: 100,
      remaining: 100 - used,
      unit: "tokens",
    },
  ],
});
const request = (attemptId: string, turnId = attemptId) => ({
  attemptId,
  scopeKey: "workspace/session/actor",
  turnId,
  workUnits: 10,
});
function answered(
  owner: RoutingScheduler,
  candidates: RoutingCandidate[],
  id = "first",
  turn = id,
) {
  const lease = owner.reserve(candidates, request(id, turn));
  lease.dispatch();
  lease.finish({ cacheUntil: 1_000_000, workUnits: 10 });
  return lease.routeId;
}

test("PRS-016 primary-backup honors order over quota balance", () => {
  const owner = new RoutingScheduler({ version: 1, strategy: "primary-backup" });
  assert.equal(owner.plan([route("a", 80), route("b", 0)], request("one")).routes[0], "a");
});

test("PRS-073 warm cache cannot take a new turn away from share rotation", () => {
  const owner = new RoutingScheduler({ version: 1, strategy: "share-rotation" }, { now: () => 0 });
  const candidates = [route("a"), route("b")];
  assert.equal(answered(owner, candidates), "a");
  assert.equal(answered(owner, candidates, "second"), "b");
});

test("PRS-024 tool continuations stay on the chosen account while a new turn rotates", () => {
  const owner = new RoutingScheduler({ version: 1, strategy: "share-rotation" });
  const candidates = [route("a"), route("b")];
  assert.equal(answered(owner, candidates, "one", "turn-1"), "a");
  assert.equal(answered(owner, candidates, "tool", "turn-1"), "a");
  assert.equal(answered(owner, candidates, "next", "turn-2"), "b");
});

test("PRS-069 a useful warm cache holds small headroom differences", () => {
  const owner = new RoutingScheduler(
    { version: 1, strategy: "headroom-balance" },
    { now: () => 0 },
  );
  answered(owner, [route("a", 20), route("b", 21)]);
  assert.equal(owner.plan([route("a", 22), route("b", 20)], request("second")).routes[0], "a");
});

test("PRS-072 a newer material headroom improvement can outweigh warm cache", () => {
  const owner = new RoutingScheduler(
    { version: 1, strategy: "headroom-balance" },
    { now: () => 0 },
  );
  answered(owner, [route("a", 20), route("b", 30)]);
  const a = route("a", 80),
    b = route("b", 10);
  a.windows[0] = { ...a.windows[0]!, revision: 2 };
  assert.equal(owner.plan([a, b], request("second")).routes[0], "b");
});

test("a newer reading on the alternative route can also justify leaving warm cache", () => {
  const owner = new RoutingScheduler(
    { version: 1, strategy: "headroom-balance" },
    { now: () => 0 },
  );
  answered(owner, [route("a", 40), route("b", 50)]);
  const a = route("a", 40),
    b = route("b", 10);
  b.windows[0] = { ...b.windows[0]!, revision: 2 };
  assert.equal(owner.plan([a, b], request("second")).routes[0], "b");
});

test("PRS-067 an account-bound turn cannot silently fall through when its route disappears", () => {
  const owner = new RoutingScheduler({ version: 1, strategy: "primary-backup" });
  const a = { ...route("a"), portability: "account-bound" as const };
  answered(owner, [a, route("b")], "one", "turn-1");
  assert.throws(() => owner.reserve([route("b")], request("tool", "turn-1")), /binding-blocked/u);
});

test("a provider-session-bound continuation stays on its account across user turns", () => {
  const owner = new RoutingScheduler({ version: 1, strategy: "share-rotation" });
  const a = { ...route("a"), portability: "provider-session-bound" as const };
  answered(owner, [a, route("b")], "first", "turn-1");
  assert.equal(owner.plan([a, route("b")], request("next", "turn-2")).routes[0], "a");
  assert.equal(owner.plan([route("b")], request("missing", "turn-2")).reason, "binding-blocked");
});

test("PRS-076 workspace and actor scope isolate bindings", () => {
  const owner = new RoutingScheduler({ version: 1, strategy: "primary-backup" });
  answered(owner, [route("a")]);
  const next = owner.reserve([route("b")], {
    ...request("first"),
    scopeKey: "other-workspace/same-session/actor",
  });
  assert.equal(next.routeId, "b");
});

test("PRS-032 expiry cold start reports its explicit fallback", () => {
  const owner = new RoutingScheduler({ version: 1, strategy: "expiry-first" });
  assert.equal(owner.plan([route("a")], request("one")).effectiveStrategy, "headroom-balance");
});

test("PRS-029 expiry priority uses attributable waste instead of the smallest reset timestamp", () => {
  const owner = new RoutingScheduler({ version: 1, strategy: "expiry-first" }, { now: () => 0 });
  const a = route("a"),
    b = route("b");
  a.expiry = {
    expiresAt: 1000,
    predictedWaste: 0,
    comparableUnit: "tokens",
    confidence: "estimated",
  };
  b.expiry = {
    expiresAt: 2000,
    predictedWaste: 50,
    comparableUnit: "tokens",
    confidence: "estimated",
  };
  assert.equal(owner.plan([a, b], request("one")).routes[0], "b");
});

test("PRS-009 all five strategies produce stable plans without changing state", () => {
  for (const strategy of [
    "reliable-first",
    "primary-backup",
    "share-rotation",
    "headroom-balance",
    "expiry-first",
  ] as RoutingStrategy[]) {
    const owner = new RoutingScheduler({ version: 1, strategy });
    const candidates = [route("a"), route("b")];
    const first = owner.plan(candidates, request("one"));
    assert.deepEqual(owner.plan(candidates, request("one")), first);
    assert.equal(owner.inspect().reservations, 0);
  }
});
