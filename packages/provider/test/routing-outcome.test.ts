import assert from "node:assert/strict";
import test from "node:test";
import { RoutingScheduler, type RoutingCandidate } from "../src/index.js";
const routes: RoutingCandidate[] = ["a", "b"].map((id) => ({
  id,
  generation: "1",
  portability: "portable",
  windows: [],
}));
const request = (attemptId: string) => ({
  attemptId,
  scopeKey: "workspace/session",
  turnId: attemptId,
  workUnits: 10,
});

test("physical HTTP completion is unknown until the SDK reports a normalized result", () => {
  const owner = new RoutingScheduler({ version: 1, strategy: "reliable-first" });
  const leases = Array.from({ length: 8 }, (_, index) => {
    const lease = owner.reserve(routes.slice(0, 1), request(String(index)));
    lease.dispatch();
    lease.finish({ outcome: "unknown" });
    return lease;
  });
  assert.equal(owner.plan(routes, request("next")).fallbackReason, "signals-unknown");
  for (const lease of leases) lease.observeUsage({ outcome: "failed" });
  assert.equal(owner.plan(routes, request("next")).routes[0], "b");
});

test("unknown completion cannot warm a cache before logical success", () => {
  const owner = new RoutingScheduler(
    { version: 1, strategy: "headroom-balance" },
    { now: () => 0 },
  );
  const candidate = (id: string, remaining: number): RoutingCandidate => ({
    ...routes[0]!,
    id,
    windows: [
      {
        resourceId: id,
        instanceId: "period",
        revision: 1,
        quality: "fresh",
        kind: "budget",
        remaining,
        limit: 100,
      },
    ],
  });
  const lease = owner.reserve([candidate("a", 60), candidate("b", 50)], request("one"));
  lease.dispatch();
  lease.finish({ outcome: "unknown", cacheUntil: 1000 });
  assert.equal(owner.plan([candidate("a", 60), candidate("b", 90)], request("two")).routes[0], "b");
  lease.observeUsage({ outcome: "success" });
  assert.equal(
    owner.plan([candidate("a", 60), candidate("b", 90)], request("three")).reason,
    "warm-cache",
  );
});

test("an SDK-confirmed pre-output rejection can release the provisional binding of an HTTP 200 error", () => {
  const owner = new RoutingScheduler({ version: 1, strategy: "primary-backup" });
  const bound = { ...routes[0]!, portability: "unknown" as const };
  const lease = owner.reserve([bound, routes[1]!], { ...request("one"), turnId: "turn" });
  lease.dispatch();
  lease.finish({ outcome: "unknown" });
  lease.observeUsage({ outcome: "failed", replaySafeFailure: true });
  const next = owner.reserve([{ ...bound, unavailable: "route-cooling" }, routes[1]!], {
    ...request("retry"),
    turnId: "turn",
  });
  assert.equal(next.routeId, "b");
  next.cancel();
});
