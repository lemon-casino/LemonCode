import assert from "node:assert/strict";
import test from "node:test";
import { RoutingScheduler, type RoutingCandidate } from "../src/index.js";
const request = {
  scopeKey: "scope",
  attemptId: "attempt",
  workUnits: 1,
  tokens: { total: 1, quality: "bound" as const },
};
function route(id: string, remaining: number[]): RoutingCandidate {
  return {
    id,
    generation: "one",
    portability: "portable",
    windows: remaining.map((left, i) => ({
      resourceId: id + i,
      instanceId: "one",
      revision: 1,
      kind: "budget",
      quality: "fresh",
      unit: "requests",
      remaining: left,
      limit: 1000,
    })),
  };
}
test("PC-07 headroom compares the secondary window after the bottleneck ties", () => {
  const owner = new RoutingScheduler(
    { version: 1, strategy: "headroom-balance" },
    { now: () => 1 },
  );
  try {
    assert.equal(
      owner.plan([route("a", [200, 300]), route("b", [200, 800])], request).routes[0],
      "b",
    );
  } finally {
    owner.dispose();
  }
});
test("PC-07 complete quota outranks an attractive percentage-only projection", () => {
  const partial = route("a", [1000]);
  partial.windows = [
    {
      resourceId: "partial",
      instanceId: "one",
      revision: 1,
      kind: "budget",
      quality: "fresh",
      unit: "requests",
      usedPercent: 0,
    },
  ];
  const owner = new RoutingScheduler(
    { version: 1, strategy: "headroom-balance" },
    { now: () => 1 },
  );
  try {
    assert.equal(owner.plan([partial, route("b", [100])], request).routes[0], "b");
  } finally {
    owner.dispose();
  }
});
test("PC-07 incomparable complete window dimensions explicitly fall back to rotation", () => {
  const a = route("a", [200]),
    b = route("b", [900]);
  b.windows[0]!.unit = "tokens";
  const owner = new RoutingScheduler(
    { version: 1, strategy: "headroom-balance" },
    { now: () => 1 },
  );
  try {
    const plan = owner.plan([a, b], request);
    assert.equal(plan.effectiveStrategy, "share-rotation");
    assert.equal(plan.fallbackReason, "quota-incomparable");
  } finally {
    owner.dispose();
  }
});
test("PC-07 load is normalized against the same admission limit", () => {
  const a = route("a", [1000]),
    b = route("b", [1000]);
  a.maxInFlight = 4;
  b.maxInFlight = 2;
  const owner = new RoutingScheduler(
    { version: 1, strategy: "primary-backup", maxInFlightPerCandidate: 4 },
    { now: () => 1 },
  );
  try {
    const one = owner.reserve([a], { ...request, attemptId: "a" }),
      two = owner.reserve([b], { ...request, attemptId: "b", scopeKey: "b" });
    owner.setPolicy({
      version: 1,
      strategy: "headroom-balance",
      maxInFlightPerCandidate: 4,
      order: ["b", "a"],
    });
    assert.equal(owner.plan([b, a], { ...request, scopeKey: "third" }).routes[0], "a");
    one.cancel();
    two.cancel();
  } finally {
    owner.dispose();
  }
});
test("PC-07 one-hour work decay beats lifetime totals without periodically rebuilding rank", () => {
  let now = 1;
  const a = route("a", [1000]),
    b = route("b", [1000]);
  const owner = new RoutingScheduler(
    { version: 1, strategy: "primary-backup" },
    { now: () => now },
  );
  try {
    const first = owner.reserve([a], { ...request, workUnits: 4096, modelKey: "model" });
    first.dispatch();
    first.finish({ outcome: "success", workUnits: 4096 });
    now += 3600000;
    const second = owner.reserve([b], {
      ...request,
      scopeKey: "b",
      attemptId: "b",
      workUnits: 3000,
      modelKey: "model",
    });
    second.dispatch();
    second.finish({ outcome: "success", workUnits: 3000 });
    owner.setPolicy({ version: 1, strategy: "headroom-balance", order: ["b", "a"] });
    assert.equal(
      owner.plan([b, a], { ...request, scopeKey: "new", modelKey: "model" }).routes[0],
      "a",
    );
  } finally {
    owner.dispose();
  }
});
test("PC-07 reliable completion includes time before dispatch", () => {
  let now = 1;
  const a = route("a", [1000]),
    b = route("b", [1000]);
  const owner = new RoutingScheduler(
    { version: 1, strategy: "primary-backup" },
    { now: () => now },
  );
  try {
    for (const candidate of [a, b])
      for (let i = 0; i < 8; i++) {
        const lease = owner.reserve([candidate], {
          ...request,
          scopeKey: candidate.id + i,
          attemptId: candidate.id + i,
          createdAt: now,
          modelKey: "model",
        });
        if (candidate.id === "a") now += 1000;
        lease.dispatch();
        now += candidate.id === "a" ? 1 : 50;
        lease.finish({ outcome: "success", workUnits: 1 });
      }
    owner.setPolicy({ version: 1, strategy: "reliable-first" });
    assert.equal(
      owner.plan([a, b], { ...request, scopeKey: "new", modelKey: "model" }).routes[0],
      "b",
    );
  } finally {
    owner.dispose();
  }
});
test("PC-07 primary and rotation preserve their ordering despite quota scores", () => {
  const a = route("a", [100]),
    b = route("b", [900]);
  for (const strategy of ["primary-backup", "share-rotation"] as const) {
    const owner = new RoutingScheduler({ version: 1, strategy }, { now: () => 1 });
    try {
      const first = owner.reserve([a, b], request);
      assert.equal(first.routeId, "a");
      first.dispatch();
      first.finish({ outcome: "success", workUnits: 1 });
      const next = owner.reserve([a, b], { ...request, attemptId: "next", scopeKey: "next" });
      assert.equal(next.routeId, strategy === "primary-backup" ? "a" : "b");
      next.cancel();
    } finally {
      owner.dispose();
    }
  }
});

// 差分覆盖紧凑索引必须保留的全局证据，而不只验证全量 planner。
for (const strategy of [
  "primary-backup",
  "share-rotation",
  "headroom-balance",
  "reliable-first",
  "expiry-first",
] as const)
  test(
    "PC-07 indexed vectors, incomplete windows and incompatible dimensions agree: " + strategy,
    () => {
      let now = 1;
      const candidates = Array.from({ length: 180 }, (_, i) => {
        const c = route(String(i), [100 + (i % 8) * 100, 100 + (i % 11) * 70]);
        c.maxInFlight = i % 2 ? 4 : 2;
        c.statistics = {
          samples: 8,
          failureRate: 0,
          completionMs: 100 + (i % 3) * 40,
          serviceMs: 50,
        };
        return c;
      });
      const policy = { version: 1 as const, strategy, maxInFlightPerCandidate: 4 };
      const flat = new RoutingScheduler(policy, { now: () => now }),
        indexed = new RoutingScheduler(policy, { now: () => now });
      indexed.setDirectory(
        candidates.map((c) => c.id),
        (id) => candidates[Number(id)]!,
      );
      try {
        for (let i = 0; i < 150; i++) {
          now += 100;
          const at = i % candidates.length,
            c = candidates[at]!;
          if (i % 5 === 0) {
            c.windows[0]!.unit = i % 10 ? "tokens" : "requests";
            indexed.touchDirectory(c.id);
          }
          if (i % 7 === 0) {
            c.windows[1]!.quality = i % 14 ? "unknown" : "fresh";
            indexed.touchDirectory(c.id);
          }
          const input = {
            ...request,
            attemptId: String(i),
            scopeKey: "s" + i,
            modelKey: "model",
            createdAt: now,
          };
          const expected = flat.reserve(candidates, input),
            actual = indexed.reserveIndexed(input);
          assert.equal(actual.routeId, expected.routeId, "step " + i);
          if (i % 3) {
            expected.dispatch();
            actual.dispatch();
            now += i % 17;
            const usage = { outcome: "success" as const, workUnits: i % 4096 };
            expected.finish(usage);
            actual.finish(usage);
          } else {
            expected.cancel();
            actual.cancel();
          }
        }
      } finally {
        flat.dispose();
        indexed.dispose();
      }
    },
  );
test("PC-07 late work adjusts the original decay bucket once and isolates models", () => {
  let now = 1;
  const a = route("a", [1000]),
    b = route("b", [1000]);
  const owner = new RoutingScheduler(
    { version: 1, strategy: "primary-backup" },
    { now: () => now },
  );
  try {
    const first = owner.reserve([a], { ...request, modelKey: "model", workUnits: 4096 });
    first.dispatch();
    first.finish({ outcome: "unknown" });
    now += 3600000;
    first.observeUsage({ outcome: "success", workUnits: 100 });
    first.observeUsage({ workUnits: 999999 });
    const second = owner.reserve([b], {
      ...request,
      scopeKey: "b",
      attemptId: "b",
      modelKey: "model",
      workUnits: 100,
    });
    second.dispatch();
    second.finish({ outcome: "success", workUnits: 100 });
    owner.setPolicy({ version: 1, strategy: "headroom-balance", order: ["b", "a"] });
    assert.equal(owner.plan([b, a], { ...request, modelKey: "model" }).routes[0], "a");
    assert.equal(owner.plan([b, a], { ...request, modelKey: "another" }).routes[0], "b");
  } finally {
    owner.dispose();
  }
});

test("PC-07 work bucket eviction invalidates the old compact winner", { timeout: 30000 }, () => {
  const candidates = Array.from({ length: 8193 }, (_, i) => route(String(i), [1000]));
  const owner = new RoutingScheduler(
    { version: 1, strategy: "headroom-balance" },
    { now: () => 1 },
  );
  owner.setDirectory(
    candidates.map((c) => c.id),
    (id) => candidates[Number(id)]!,
  );
  try {
    const cold = owner.reserveIndexed({ ...request, modelKey: "model", attemptId: "cold" });
    cold.cancel();
    for (const index of [8191, ...Array.from({ length: 8191 }, (_, i) => i), 8192]) {
      const c = candidates[index]!,
        lease = owner.reserve([c], {
          ...request,
          modelKey: "model",
          attemptId: "done" + index,
          scopeKey: "scope" + index,
        });
      lease.dispatch();
      lease.finish({ outcome: "success", workUnits: index === 8191 ? 100000 : 1 });
    }
    const input = { ...request, modelKey: "model", attemptId: "after", scopeKey: "after" };
    assert.equal(owner.plan(candidates, input).routes[0], "8191");
    const lease = owner.reserveIndexed(input);
    assert.equal(lease.routeId, "8191");
    lease.cancel();
  } finally {
    owner.dispose();
  }
});
