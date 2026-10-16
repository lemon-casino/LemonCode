import assert from "node:assert/strict";
import test from "node:test";
import { RoutingScheduler, type RoutingCandidate } from "../src/index.js";
for (const sameGroup of [true, false])
  test(`cache group ${sameGroup ? "reuse permits" : "separation resists"} a small boundary improvement`, () => {
    const owner = new RoutingScheduler(
      { version: 1, strategy: "headroom-balance" },
      { now: () => 1 },
    );
    const candidate = (id: string): RoutingCandidate => ({
      id,
      generation: "1",
      portability: "portable",
      cacheGroupId: id === "a" || sameGroup ? "shared-cache" : "separate-cache",
      windows: [
        {
          resourceId: id,
          instanceId: "p",
          revision: 1,
          kind: "budget",
          quality: "fresh",
          remaining: 80,
          limit: 100,
          unit: "tokens",
        },
      ],
    });
    const candidates = [candidate("a"), candidate("b")];
    owner.setDirectory(
      candidates.map((c) => c.id),
      (id) => candidates.find((c) => c.id === id)!,
    );
    const first = owner.reserveIndexed({
      attemptId: "first",
      scopeKey: "scope",
      turnId: "one",
      tokens: { total: 1, quality: "bound" },
    });
    assert.equal(first.routeId, "a");
    first.dispatch();
    first.finish({ outcome: "success", cacheUntil: 10_000 });
    candidates[0]!.windows[0] = { ...candidates[0]!.windows[0]!, remaining: 78, revision: 2 };
    candidates[1]!.windows[0] = { ...candidates[1]!.windows[0]!, remaining: 82, revision: 2 };
    owner.touchDirectory("a");
    owner.touchDirectory("b");
    const next = owner.reserveIndexed({
      attemptId: "next",
      scopeKey: "scope",
      turnId: "two",
      tokens: { total: 1, quality: "bound" },
    });
    assert.equal(next.routeId, sameGroup ? "b" : "a");
    next.cancel();
    owner.dispose();
  });
