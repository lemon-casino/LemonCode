import assert from "node:assert/strict";
import test from "node:test";
import { readRoutingCacheFacts } from "../src/routing/cache-facts.js";
test("HD-07 explicit cache facts retain provenance, expiration and units; missing facts stay unknown", () => {
  assert.equal(readRoutingCacheFacts(new Headers(), 100), undefined);
  const headers = new Headers({
    "x-lcode-cache-ttl-ms": "1000",
    "x-lcode-cache-group": "shared",
    "x-lcode-cache-portability": "portable",
    "x-lcode-cache-switch-cost": "12",
    "x-lcode-cache-switch-unit": "tokens",
  });
  const fact = readRoutingCacheFacts(headers, 100)!;
  assert.equal(fact.validUntil, 1100);
  assert.equal(fact.groupId, "shared");
  assert.deepEqual(fact.switchCost, { amount: 12, unit: "tokens" });
  assert.equal(
    readRoutingCacheFacts(new Headers({ "x-lcode-cache-ttl-ms": "NaN" }), 100),
    undefined,
  );
  assert.equal(
    readRoutingCacheFacts(new Headers({ "x-lcode-cache-switch-cost": "0" }), 100),
    undefined,
  );
});
