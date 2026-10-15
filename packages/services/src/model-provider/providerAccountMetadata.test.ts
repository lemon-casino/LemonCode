import assert from "node:assert/strict";
import test from "node:test";
import {
  createAccountProviderConfigSnapshot,
  ProviderConfigMap,
  serializeAccountProviderConfigSnapshot,
  parseAccountModelCatalog,
} from "@lcode/provider";
import { modelSchema } from "./providerAccountStoreSchema.js";
import { createProviderAccountsSource } from "./providerAccountsSource.js";

test("account metadata preserves friendly names and billing without leaking into request model configuration", async () => {
  const model = modelSchema.parse({
    id: "exact-id",
    name: "Friendly name",
    protocol: "openai-responses",
    baseURL: "https://fixture.invalid",
    billing: { kind: "multiplier", multiplier: 0.25 },
  });
  const accounts = ["a", "b"].map((connectionId) => ({
    connectionId,
    channelId: "workbuddy",
    displayName: connectionId,
    enabled: true,
    models: [structuredClone(model)],
  }));
  const empty = createAccountProviderConfigSnapshot("builtin", ProviderConfigMap.empty());
  const source = createProviderAccountsSource(
    { read: async () => empty, refresh: async () => empty, onDidChange: () => () => {} },
    {
      readAccounts: async () => accounts,
      channelName: () => "WorkBuddy",
      onDidChange: () => ({ dispose() {} }),
    },
  );
  const same = await source.read();
  assert.deepEqual(same.modelCatalog?.["oauth:workbuddy"]?.["exact-id"], {
    name: "Friendly name",
    billing: model.billing,
  });
  const wire = serializeAccountProviderConfigSnapshot(same);
  assert.deepEqual(parseAccountModelCatalog(wire.modelCatalog, same.providers), same.modelCatalog);
  assert.equal(JSON.stringify(wire.modelRules).includes("multiplier"), false);
  accounts[1]!.models[0]!.billing = { kind: "multiplier", multiplier: 0.71 };
  const mixed = await source.read();
  assert.notEqual(mixed.revision, same.revision);
  assert.deepEqual(mixed.modelCatalog?.["oauth:workbuddy"]?.["exact-id"]?.billing, {
    kind: "mixed",
  });
  accounts[1]!.enabled = false;
  assert.deepEqual(
    (await source.read()).modelCatalog?.["oauth:workbuddy"]?.["exact-id"]?.billing,
    model.billing,
  );
  accounts[0]!.models[0]!.billing = undefined;
  assert.equal(
    (await source.read()).modelCatalog?.["oauth:workbuddy"]?.["exact-id"]?.billing,
    undefined,
  );
  assert.throws(() =>
    parseAccountModelCatalog({ other: { "exact-id": { name: "Unsafe" } } }, same.providers),
  );
  assert.throws(() =>
    parseAccountModelCatalog(
      { "oauth:workbuddy": { unauthorized: { name: "Unsafe" } } },
      same.providers,
    ),
  );
  assert.throws(() =>
    parseAccountModelCatalog(
      { "oauth:workbuddy": { "exact-id": { name: "Unsafe", access: "secret" } } },
      same.providers,
    ),
  );
});
