import assert from "node:assert/strict";
import test from "node:test";
import { parseProviderConfig, ProviderConfig } from "../src/index.js";

const strategies = [
  "reliable-first",
  "primary-backup",
  "share-rotation",
  "headroom-balance",
  "expiry-first",
] as const;

test("PRS-001 absent routing remains absent across overlays and serialization", () => {
  const config = new ProviderConfig({ network: { mode: "direct" } });
  assert.equal(Object.hasOwn(config.toJSON(), "routing"), false);
  assert.equal(
    Object.hasOwn(
      config.overlay(new ProviderConfig({ visibility: "visible" })).toJSON(),
      "routing",
    ),
    false,
  );
});

test("PRS-003 five explicit routing strategies round trip through the actual provider config", () => {
  for (const strategy of strategies) {
    const config = parseProviderConfig({ routing: { version: 1, strategy } });
    assert.equal(config.routing?.strategy, strategy);
    assert.deepEqual(new ProviderConfig(config.toJSON()).withoutGroup().routing, config.routing);
    assert.deepEqual(config.withModelMembershipFrom(undefined).routing, config.routing);
  }
});

test("PRS-003 future versions, duplicate routes, invalid shares and nonfinite limits are rejected", () => {
  for (const routing of [
    { version: 2, strategy: "reliable-first" },
    { version: 1, strategy: "smart" },
    { version: 1, strategy: "share-rotation", order: ["a", "a"] },
    { version: 1, strategy: "share-rotation", weights: { a: 0 } },
    { version: 1, strategy: "share-rotation", maxInFlightPerCandidate: Infinity },
  ])
    assert.throws(() => parseProviderConfig({ routing }));
});

test("published routing policy cannot be mutated through nested config references", () => {
  const config = parseProviderConfig({
    routing: {
      version: 1,
      strategy: "share-rotation",
      order: ["a", "b"],
      weights: { a: 2 },
      reserveRules: [{ resourceId: "weekly", mode: "soft", minRemainingPercent: 20 }],
    },
  });
  assert.throws(() => config.routing!.order!.push("c"));
  assert.throws(() => {
    config.routing!.weights!.a = 90;
  });
  assert.throws(() => {
    config.routing!.reserveRules![0]!.minRemainingPercent = 0;
  });
});
