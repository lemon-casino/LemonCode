import assert from "node:assert/strict";
import test from "node:test";
import { disableProviderApiKey, selectProviderApiKey } from "./providerApiKeys.js";

test("disabled key falls through to the next key", () => {
  const keys = [
    { id: "a", apiKey: "bad", enabled: false },
    { id: "b", apiKey: "good" },
  ];
  assert.equal(selectProviderApiKey(keys)?.id, "b");
  assert.equal(selectProviderApiKey(disableProviderApiKey(keys, "b")), null);
});
