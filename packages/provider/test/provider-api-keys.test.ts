import assert from "node:assert/strict";
import test from "node:test";
import { completeApiKeyAccessDataSchema } from "../src/config/provider-data-schema.js";
import { resolveApiKeyAccessKeys } from "../src/config/provider-config.js";

test("legacy apiKey is projected as one enabled key", () => {
  assert.deepEqual(resolveApiKeyAccessKeys({ apiKey: " legacy " }), [
    { id: "legacy", label: "API Key 1", apiKey: "legacy", enabled: true },
  ]);
});

test("configured key list is normalized and takes precedence over legacy apiKey", () => {
  assert.deepEqual(
    resolveApiKeyAccessKeys({
      apiKey: "legacy",
      apiKeys: [
        { id: "first", apiKey: " one ", enabled: true },
        { id: "duplicate", apiKey: "one", enabled: false },
        { id: "second", label: " Backup ", apiKey: "two", enabled: false },
      ],
    }),
    [
      { id: "first", apiKey: "one", enabled: true },
      { id: "second", label: "Backup", apiKey: "two", enabled: false },
    ],
  );
});

test("complete access accepts an enabled apiKeys entry without legacy apiKey", () => {
  assert.equal(
    completeApiKeyAccessDataSchema.safeParse({
      type: "api-key",
      apiKeys: [{ id: "primary", apiKey: "secret", enabled: true }],
    }).success,
    true,
  );
});
