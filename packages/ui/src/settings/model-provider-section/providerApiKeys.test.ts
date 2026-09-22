import assert from "node:assert/strict";
import test from "node:test";
import {
  createProviderApiKeyOperationGuard,
  disableProviderApiKey,
  selectProviderApiKey,
} from "./providerApiKeys.js";

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
