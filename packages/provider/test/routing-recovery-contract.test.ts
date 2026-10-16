import assert from "node:assert/strict";
import test from "node:test";
import { RoutingScheduler, type RoutingCandidate } from "../src/index.js";

const request = (id: string, modelKey = "chat/model") => ({
  attemptId: id,
  scopeKey: modelKey,
  modelKey,
  turnId: id,
  workUnits: 4096,
});
const route = (id: string): RoutingCandidate => ({
  id,
  generation: "one",
  portability: "portable",
  windows: [],
  statistics: { samples: 50, failureRate: 0, completionMs: 1000 },
});

test("RCD-03 directory projections receive their own model context during selection and refresh", () => {
  const owner = new RoutingScheduler({ version: 1, strategy: "primary-backup" });
  owner.setDirectory(["a", "b"], (id, context) => ({
    ...route(id),
    ...(id === "a" && context?.modelKey === "one" ? { unavailable: "route-cooling" } : {}),
  }));
  const first = owner.reserveIndexed(request("one", "one"));
  assert.equal(first.routeId, "b");
  first.cancel();
  const second = owner.reserveIndexed(request("two", "two"));
  assert.equal(second.routeId, "a");
  second.cancel();
  owner.touchDirectory("a");
  const refreshed = owner.reserveIndexed(request("three", "one"));
  assert.equal(refreshed.routeId, "b");
  refreshed.cancel();
});

test("RCD-10 owner diagnostics retain actual fallback and split usage without advancing scheduling", () => {
  const owner = new RoutingScheduler({ version: 1, strategy: "expiry-first" }, { now: () => 100 });
  const candidate = {
    ...route("a"),
    statistics: undefined,
    windows: [
      {
        resourceId: "tokens",
        instanceId: "one",
        revision: 1,
        kind: "budget" as const,
        quality: "fresh" as const,
        remaining: 100,
        unit: "tokens",
      },
    ],
  };
  const lease = owner.reserve([candidate], {
    ...request("private-request"),
    tokens: { total: 60, quality: "bound" },
  });
  lease.dispatch();
  lease.finish({ outcome: "unknown" });
  const before = owner.inspect();
  const view = owner.readDiagnostics();
  assert.equal(view.source, "local-owner");
  assert.equal(view.lastDecision?.phase, "ended");
  assert.equal(view.lastDecision?.outcome, "unknown");
  assert.equal(view.lastDecision?.requestedStrategy, "expiry-first");
  // 只有绝对余额、没有 limit，不能把压力猜成零；原借记和反馈语义仍独立有效。
  assert.equal(view.lastDecision?.effectiveStrategy, "share-rotation");
  assert.equal(view.lastDecision?.fallbackReason, "expiry-unverifiable");
  assert.equal(view.resources[0]!.endedEstimated, 60);
  assert.equal(view.resources[0]!.available, 40);
  assert.equal(JSON.stringify(view).includes("private-request"), false);
  assert.deepEqual(owner.inspect(), before);
  lease.observeUsage({ outcome: "success", actualDemands: { tokens: 15 } });
  assert.equal(owner.readDiagnostics().resources[0]!.endedActual, 15);
});

test("RCD-01 cache cannot override a better reliable failure band for OAuth or API", () => {
  const owner = new RoutingScheduler({ version: 1, strategy: "reliable-first" }, { now: () => 1 });
  const routes = [route("a"), route("b")];
  const first = owner.reserve(routes, request("first"));
  first.dispatch();
  first.finish({ outcome: "success", cacheUntil: 100000 });
  routes[0]!.statistics!.failureRate = 0.1;
  routes[1]!.statistics!.failureRate = 0.06;
  const plan = owner.plan(routes, request("next"));
  assert.equal(plan.routes[0], "b");
  assert.equal(plan.cacheDecision?.reason, "better-reliability-band");
});

for (const [cost, unit, expected, reason] of [
  [undefined, undefined, "a", "cache-cost-unverifiable"],
  [15, "tokens", "a", "cache-rebuild-exceeds-benefit"],
  [5, "tokens", "b", "positive-expiry-net-benefit"],
  [1, "credits", "a", "cache-cost-unverifiable"],
] as const)
  test(`RCD-02 expiry cache switch cost ${cost}/${unit} uses a comparable positive net benefit`, () => {
    const owner = new RoutingScheduler({ version: 1, strategy: "expiry-first" }, { now: () => 1 });
    const routes = ["a", "b"].map(
      (id): RoutingCandidate => ({
        ...route(id),
        cacheGroupId: id,
        windows: [
          {
            resourceId: id,
            instanceId: "period",
            revision: 1,
            kind: "expiring-balance",
            quality: "fresh",
            remaining: 1000,
            limit: 1000,
            unit: "tokens",
          },
        ],
        expiry: {
          resourceId: id,
          predictedWaste: id === "a" ? 1 : 20,
          expiresAt: 1000,
          comparableUnit: "tokens",
          confidence: "estimated",
        },
        ...(cost !== undefined ? { cacheSwitchCost: { amount: cost, unit: unit! } } : {}),
      }),
    );
    const input = { ...request("first"), tokens: { total: 10, quality: "bound" as const } };
    const first = owner.reserve([routes[0]!], input);
    first.dispatch();
    first.finish({ outcome: "success", cacheUntil: 100000 });
    const plan = owner.plan(routes, { ...input, attemptId: "next", turnId: "next" });
    assert.equal(plan.routes[0], expected);
    assert.equal(plan.cacheDecision?.reason, reason);
  });

test("RCD-03 physical failures from one model do not contaminate another model", () => {
  const owner = new RoutingScheduler({ version: 1, strategy: "reliable-first" }, { now: () => 1 });
  const routes = [route("a"), route("b")].map(
    ({ statistics: _statistics, ...candidate }) => candidate,
  );
  for (let i = 0; i < 8; i++) {
    const lease = owner.reserve([routes[0]!], request(String(i), "protocol/model-A"));
    lease.dispatch();
    lease.finish({ outcome: "failed" });
  }
  // 统计隔离不拆工作债务；新模型必须进入信号未知回退，不能拿其它模型的失败率继续排序。
  assert.equal(
    owner.plan(routes, request("new", "protocol/model-B")).effectiveStrategy,
    "share-rotation",
  );
});

test("RCD-04 disabled candidates recover with at most one round of positive credit", () => {
  const owner = new RoutingScheduler({ version: 1, strategy: "share-rotation" });
  const routes = [route("a"), route("b")];
  let index = 0;
  const complete = () => {
    const lease = owner.reserve(routes, request(String(index++)));
    lease.dispatch();
    lease.finish({ outcome: "success", workUnits: 4096 });
    return lease.routeId;
  };
  assert.equal(complete(), "a");
  routes[0]!.unavailable = "disabled";
  for (let i = 0; i < 40; i++) complete();
  delete routes[0]!.unavailable;
  const restored = Array.from({ length: 6 }, complete);
  assert.ok(restored.filter((id) => id === "b").length >= 2, JSON.stringify(restored));
});
