import assert from "node:assert/strict";
import test from "node:test";
import {
  createProviderApiKeyOperationGuard,
  normalizeProviderApiKeys,
  disableProviderApiKey,
  selectProviderApiKey,
} from "./providerApiKeys.js";

test("normalizing a loaded Key draft preserves dedicated routing metadata", () => {
  const routing = {
    quotaPoolId: "team",
    cacheGroupId: "cache",
    cacheTtlMs: 60_000,
    weight: 3,
    priority: 1,
  };
  const rows = normalizeProviderApiKeys([{ id: "a", apiKey: " synthetic ", routing }]);
  assert.deepEqual(rows[0]!.routing, routing);
  assert.equal(rows[0]!.apiKey, "synthetic");
});

test("disabled key falls through to the next key", () => {
  const keys = [
    { id: "a", apiKey: "bad", enabled: false },
    { id: "b", apiKey: "good" },
  ];
  assert.equal(selectProviderApiKey(keys)?.id, "b");
  assert.equal(selectProviderApiKey(disableProviderApiKey(keys, "b")), null);
});

test("provider switch invalidates the previous API key operation", () => {
  const guard = createProviderApiKeyOperationGuard("provider-a");
  const providerAOperation = guard.begin();
  assert.equal(guard.isCurrent(providerAOperation), true);

  guard.setScope("provider-b");
  assert.equal(guard.isCurrent(providerAOperation), false);

  const providerBOperation = guard.begin();
  assert.equal(guard.isCurrent(providerBOperation), true);
  guard.invalidate();
  assert.equal(guard.isCurrent(providerBOperation), false);
});

test("same provider updates do not invalidate an active API key operation", () => {
  const guard = createProviderApiKeyOperationGuard("provider-a");
  const operation = guard.begin();

  guard.setScope("provider-a");
  assert.equal(guard.isCurrent(operation), true);
});
