import assert from "node:assert/strict";
import test from "node:test";
import { RoutingScheduler, type RoutingCandidate } from "../src/index.js";

test("expiry forecast requires measured same-unit demand and subtracts already reserved work", () => {
  let now = 0;
  const owner = new RoutingScheduler({ version: 1, strategy: "expiry-first" }, { now: () => now });
  const a: RoutingCandidate = {
    id: "a",
    generation: "1",
    portability: "portable",
    windows: [
      {
        resourceId: "a",
        instanceId: "period",
        revision: 1,
        quality: "fresh",
        kind: "expiring-balance",
        remaining: 1000,
        limit: 1000,
        unit: "requests",
        expiresAt: 3_600_000,
      },
    ],
  };
  const b: RoutingCandidate = {
    id: "b",
    generation: "1",
    portability: "portable",
    windows: [
      {
        resourceId: "b",
        instanceId: "period",
        revision: 1,
        quality: "fresh",
        kind: "budget",
        remaining: 1000,
        limit: 1000,
        unit: "requests",
      },
    ],
  };
  const request = (attemptId: string, demand = 1) => ({
    attemptId,
    scopeKey: "workspace/session",
    turnId: attemptId,
    workUnits: 4096,
    demands: { a: demand, b: 1 },
  });
  assert.equal(owner.plan([a, b], request("cold")).fallbackReason, "expiry-unverifiable");
  for (let index = 0; index < 8; index++) {
    now = index * 10_000;
    const lease = owner.reserve([a], request(String(index)));
    lease.dispatch();
    lease.finish({ actualDemands: { a: 1 }, workUnits: 4096 });
  }
  assert.equal(owner.plan([a, b], request("measured")).effectiveStrategy, "expiry-first");
  assert.equal(owner.plan([a, b], request("measured")).routes[0], "a");
  const held = owner.reserve([a], request("held", 991));
  held.dispatch();
  const plan = owner.plan([a, b], request("new"));
  // 到期预测不足后，budget 与 expiring-balance 的完整维度仍不可互比，继续明确回退轮转。
  assert.equal(plan.effectiveStrategy, "share-rotation");
  assert.equal(plan.fallbackReason, "expiry-unverifiable");
  assert.equal(plan.routes[0], "b");
  held.finish({ outcome: "cancelled" });
  owner.dispose();
});
