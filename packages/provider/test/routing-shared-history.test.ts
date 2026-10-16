import assert from "node:assert/strict";
import test from "node:test";
import { RoutingScheduler, type RoutingCandidate } from "../src/index.js";
test("shared expiry forecasting uses each physical sample once across rotating Keys", () => {
  let now = 0;
  const scheduler = new RoutingScheduler(
    { version: 1, strategy: "expiry-first" },
    { now: () => now },
  );
  const candidates: RoutingCandidate[] = ["a", "b"].map((id) => ({
    id,
    generation: "1",
    portability: "portable",
    quotaGroupId: "team",
    windows: [
      {
        resourceId: "shared",
        instanceId: "period",
        revision: 1,
        kind: "expiring-balance",
        quality: "fresh",
        shared: true,
        remaining: 1000,
        limit: 1000,
        unit: "requests",
        expiresAt: 350_000,
      },
    ],
  }));
  for (let i = 0; i < 8; i++) {
    now = i * 10_000;
    const lease = scheduler.reserve([candidates[i % 2]!], {
      attemptId: String(i),
      scopeKey: "sampling",
      workUnits: 1,
    });
    lease.dispatch();
    lease.finish({ outcome: "success", workUnits: 1, actualDemands: { shared: 1 } });
  }
  const plan = scheduler.plan(candidates, { attemptId: "plan", scopeKey: "scope", workUnits: 1 });
  assert.equal(plan.effectiveStrategy, "expiry-first");
  assert.equal(plan.fallbackReason, undefined);
  scheduler.dispose();
});
