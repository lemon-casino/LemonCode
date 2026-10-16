import assert from "node:assert/strict";
import test from "node:test";
import { RoutingScheduler, type RoutingCandidate } from "../src/index.js";
const candidates: RoutingCandidate[] = ["a", "b"].map((id) => ({
  id,
  generation: "1",
  portability: "portable",
  windows: [],
}));
const request = (attemptId: string) => ({
  attemptId,
  scopeKey: "workspace/session/actor",
  turnId: attemptId,
  workUnits: 4096,
});

test("invalid finish cannot leak a slot and usage arriving before body end is reconciled exactly once", () => {
  const owner = new RoutingScheduler({ version: 1, strategy: "share-rotation" });
  const lease = owner.reserve(candidates, request("one"));
  lease.dispatch();
  assert.throws(() => lease.finish({ workUnits: NaN }), /invalid-usage/);
  assert.equal(owner.inspect().reservations, 1);
  lease.observeUsage({ workUnits: 8192 });
  assert.equal(owner.inspect().reservations, 1);
  lease.finish({});
  assert.equal(owner.inspect().reservations, 0);
  assert.equal(owner.inspect().shares.find(([id]) => id === "a")?.[1], -4096);
  lease.observeUsage({ workUnits: 0 });
  assert.equal(owner.inspect().shares.find(([id]) => id === "a")?.[1], -4096);
});

test("percentage exhaustion is binding and passing a reset does not manufacture a new allowance", () => {
  const owner = new RoutingScheduler(
    { version: 1, strategy: "headroom-balance" },
    { now: () => 10_000 },
  );
  const a = {
    ...candidates[0]!,
    windows: [
      {
        resourceId: "short",
        instanceId: "old",
        revision: 1,
        kind: "rate" as const,
        quality: "fresh" as const,
        usedPercent: 100,
      },
    ],
  };
  assert.equal(owner.plan([a, candidates[1]!], request("one")).routes[0], "b");
  a.windows[0] = { ...a.windows[0]!, resetAt: 9_000 } as (typeof a.windows)[number];
  assert.equal(owner.plan([a], request("two")).fallbackReason, "quota-unknown");
});

test("reliable-first learns failures from physical outcomes without inventing zero-history statistics", () => {
  const owner = new RoutingScheduler({ version: 1, strategy: "reliable-first" });
  for (let index = 0; index < 8; index++) {
    for (const route of candidates) {
      const lease = owner.reserve([route], request(`${route.id}-${index}`));
      lease.dispatch();
      lease.finish({ outcome: route.id === "a" ? "failed" : "success" });
    }
  }
  assert.equal(owner.plan(candidates, request("next")).routes[0], "b");
});

test("unknown alternatives get bounded exploration and repeated previews do not spend the exploration turn", () => {
  const owner = new RoutingScheduler({ version: 1, strategy: "headroom-balance" });
  const known = {
    ...candidates[0]!,
    windows: [
      {
        resourceId: "a",
        instanceId: "period",
        revision: 1,
        kind: "budget" as const,
        quality: "fresh" as const,
        remaining: 100,
        limit: 100,
      },
    ],
  };
  for (let index = 0; index < 31; index++) {
    const lease = owner.reserve([known, candidates[1]!], request(String(index)));
    assert.equal(lease.routeId, "a");
    lease.dispatch();
    lease.finish({ outcome: "success" });
  }
  for (let index = 0; index < 10; index++)
    assert.equal(owner.plan([known, candidates[1]!], request("probe")).routes[0], "b");
  const probe = owner.reserve([known, candidates[1]!], request("probe"));
  probe.dispatch();
  probe.finish({});
  assert.equal(owner.plan([known, candidates[1]!], request("next")).routes[0], "a");
});

test("a policy edit invalidates an undispatched reservation while an already dispatched request can settle", () => {
  const owner = new RoutingScheduler({ version: 1, strategy: "primary-backup" });
  const pending = owner.reserve(candidates, request("pending"));
  owner.setPolicy({ version: 1, strategy: "primary-backup", order: ["b", "a"] });
  assert.throws(() => pending.dispatch(), /policy-conflict/);
  assert.equal(owner.inspect().reservations, 0);
  const active = owner.reserve(candidates, request("active"));
  assert.equal(active.routeId, "b");
  active.dispatch();
  owner.setPolicy({ version: 1, strategy: "share-rotation" });
  active.finish({ outcome: "success" });
  assert.equal(owner.inspect().reservations, 0);
});

test("route IDs that match object properties do not disappear or inherit a share", () => {
  const owner = new RoutingScheduler({ version: 1, strategy: "share-rotation", weights: {} });
  const routes = ["constructor", "toString"].map((id) => ({ ...candidates[0]!, id }));
  const lease = owner.reserve(routes, request("safe-id"));
  assert.equal(lease.routeId, "constructor");
  assert.ok(owner.inspect().shares.every(([, value]) => Number.isFinite(value)));
  lease.cancel();
});

test("parallel reservations in an account-bound turn stay together and cancelled provisional bindings roll back", () => {
  const owner = new RoutingScheduler({ version: 1, strategy: "share-rotation" });
  const routes = candidates.map((candidate) => ({
    ...candidate,
    portability: "account-bound" as const,
    windows: [
      {
        resourceId: candidate.id,
        instanceId: "period",
        revision: 1,
        quality: "fresh" as const,
        kind: "budget" as const,
        remaining: 100,
        limit: 100,
      },
    ],
  }));
  const first = owner.reserve(routes, { ...request("one"), turnId: "same" });
  const second = owner.reserve(routes, { ...request("two"), turnId: "same" });
  assert.equal(first.routeId, second.routeId);
  first.cancel();
  second.cancel();
  const next = owner.reserve(routes.slice(1), { ...request("next"), turnId: "same" });
  assert.equal(next.routeId, "b");
  next.cancel();
});

test("an older turn finishing late cannot overwrite the newer turn's cache binding", () => {
  const owner = new RoutingScheduler({ version: 1, strategy: "share-rotation" });
  const old = owner.reserve(candidates, { ...request("old"), turnId: "old-turn" });
  old.dispatch();
  const current = owner.reserve(candidates, { ...request("current"), turnId: "current-turn" });
  current.dispatch();
  current.finish({});
  old.finish({});
  const tool = owner.reserve(candidates, { ...request("tool"), turnId: "current-turn" });
  assert.equal(tool.routeId, current.routeId);
  tool.cancel();
});

test("reliable cold start rotates unknown routes rather than starving every route after the first", () => {
  const owner = new RoutingScheduler({ version: 1, strategy: "reliable-first" });
  const selected: string[] = [];
  for (let index = 0; index < 8; index++) {
    const lease = owner.reserve(candidates, request(String(index)));
    selected.push(lease.routeId);
    lease.dispatch();
    lease.finish({ outcome: "success" });
  }
  assert.deepEqual(selected, ["a", "b", "a", "b", "a", "b", "a", "b"]);
});

test("a measured failing connection cannot outrank an unexplored alternative as if unknown meant worse", () => {
  const owner = new RoutingScheduler({ version: 1, strategy: "reliable-first" });
  for (let index = 0; index < 8; index++) {
    const lease = owner.reserve(candidates.slice(0, 1), request(String(index)));
    lease.dispatch();
    lease.finish({ outcome: "failed" });
  }
  assert.equal(owner.plan(candidates, request("probe")).routes[0], "b");
});
