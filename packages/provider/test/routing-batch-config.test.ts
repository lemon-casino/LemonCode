import assert from "node:assert/strict";
import test from "node:test";
import { ApiKeyAccessConfig, resolveApiKeyAccessKeys } from "../src/index.js";
test("batch Key routing metadata survives validation, normalization and immutable snapshots", () => {
  const routing = { quotaPoolId: "team", cacheGroupId: "cache", cacheTtlMs: 60_000 };
  const access = new ApiKeyAccessConfig({ apiKeys: [{ id: "a", apiKey: "synthetic", routing }] });
  assert.deepEqual(access.validateComplete(), []);
  routing.quotaPoolId = "changed";
  assert.equal(access.apiKeys![0]!.routing!.quotaPoolId, "team");
  assert.equal(Object.isFrozen(access.apiKeys![0]!.routing), true);
  assert.equal(resolveApiKeyAccessKeys(access)[0]!.routing!.quotaPoolId, "team");
});
