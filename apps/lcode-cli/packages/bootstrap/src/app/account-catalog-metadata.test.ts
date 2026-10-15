import assert from "node:assert/strict";
import test from "node:test";
import { parseProcessAccountProviderConfigSnapshot } from "./process-provider-registry-runtime.js";
import { lcodeProviderUpdateAccountConfigParamsSchema } from "@lcode/shared";

test("strict Host to Agent catalog envelope retains billing only within the authorized OAuth model scope", () => {
  const envelope = { revision: "account-fixture", basedOnLCodeBuiltinRevision: "builtin", states: {},
    providers: { "oauth:workbuddy": { group: "standard-personal", access: { type: "oauth-account", channelId: "workbuddy" },
      api: { type: "openai-responses", baseUrl: "https://oauth.invalid/v1" }, builtinModelIds: ["exact-id"] } },
    modelCatalog: { "oauth:workbuddy": { "exact-id": { name: "Friendly name", billing: { kind: "multiplier", multiplier: 0.71 } } } } };
  const parsed = lcodeProviderUpdateAccountConfigParamsSchema.parse(envelope);
  const snapshot = parseProcessAccountProviderConfigSnapshot(parsed);
  assert.deepEqual(snapshot.modelCatalog, envelope.modelCatalog);
  assert.throws(() => parseProcessAccountProviderConfigSnapshot({ ...envelope,
    modelCatalog: { "oauth:workbuddy": { other: { name: "Unauthorized" } } } }));
  assert.equal(lcodeProviderUpdateAccountConfigParamsSchema.safeParse({ ...envelope,
    modelCatalog: { "oauth:workbuddy": { "exact-id": { name: "Invalid", billing: { kind: "multiplier", multiplier: -1 } } } } }).success, false);
  assert.equal(parseProcessAccountProviderConfigSnapshot({ ...envelope, modelCatalog: undefined }).modelCatalog, undefined);
});
