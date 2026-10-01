import assert from "node:assert/strict";
import test from "node:test";
import {
  ModelConfigRules,
  ProviderConfig,
  ProviderConfigMap,
  parseAccountProviderConfigMap,
  parseLCodeBuiltinProviderConfigMap,
  parsePersonalProviderConfigMap,
  parseProviderConfig,
  parseProviderTemplateMap,
  serializeRegistryProviderConfig,
  createRegistryProviderConfig,
} from "../src/index.js";
import { roundtrip } from "./model-membership.fixture.js";

const ids = [" Model ", "Model", "model", "Model-v2", " Model-v2 "];
const expected = ["Model", "model", "Model-v2"];

test("all membership lists trim and deduplicate exact IDs during construction and overlay", () => {
  const config = new ProviderConfig({
    builtinModelIds: ids,
    personalModelIds: ids,
    modelOrder: ids,
    excludedModelIds: ids,
  });
  for (const key of [
    "builtinModelIds",
    "personalModelIds",
    "modelOrder",
    "excludedModelIds",
  ] as const) {
    assert.deepEqual(config[key], expected);
    assert.equal(Object.isFrozen(config[key]), true);
    assert.throws(() => new ProviderConfig({ [key]: [" "] }), /Model ID 不能为空/);
  }
  assert.deepEqual(parseProviderConfig(config.toJSON()).toJSON(), config.toJSON());
  assert.deepEqual(config.overlay(new ProviderConfig()).toJSON(), config.toJSON());
  assert.deepEqual(config.withoutGroup().excludedModelIds, expected);
  assert.deepEqual(
    new ProviderConfig({ excludedModelIds: [] }).withModelMembershipFrom(config).excludedModelIds,
    expected,
  );
  assert.deepEqual(
    config.overlay(new ProviderConfig({ excludedModelIds: [] })).excludedModelIds,
    [],
  );
});

test("legacy personal config remains valid and codec roundtrip preserves exclusions", () => {
  const legacy = parsePersonalProviderConfigMap({
    providerRules: [
      {
        providerId: "personal",
        config: { group: "standard-personal", personalModelIds: ids },
      },
    ],
  });
  assert.deepEqual(legacy.get("personal")?.personalModelIds, expected);
  assert.equal(legacy.get("personal")?.excludedModelIds, undefined);
  const providers = parsePersonalProviderConfigMap({
    providerRules: [
      {
        providerId: "personal",
        config: { group: "standard-personal", excludedModelIds: ids },
      },
    ],
  });
  const saved = roundtrip({ providers, models: ModelConfigRules.empty() });
  assert.deepEqual(saved.providers.get("personal")?.excludedModelIds, expected);
  assert.deepEqual(roundtrip(saved), saved);
});

test("builtin, template and account source schemas reject personal exclusion ownership", () => {
  assert.throws(() =>
    parseLCodeBuiltinProviderConfigMap([
      {
        providerId: "builtin",
        config: { group: "zai-family", excludedModelIds: ["Model"] },
      },
    ]),
  );
  assert.throws(() =>
    parseProviderTemplateMap([
      {
        templateId: "template",
        templateNameMap: { "en-US": "Example" },
        config: { excludedModelIds: ["Model"] },
      },
    ]),
  );
  assert.throws(() =>
    parseAccountProviderConfigMap({ "account:test": { excludedModelIds: ["Model"] } }),
  );
});

test("registry serialization retains exclusions without altering inherited identity", () => {
  const config = parseProviderConfig({
    group: "standard-personal",
    access: { type: "api-key", apiKey: "test-key" },
    api: { type: "openai-chat-completions", baseUrl: "https://example.test/v1" },
    builtinModelIds: ["Model"],
    excludedModelIds: ["Model"],
  });
  const complete = createRegistryProviderConfig(config);
  if (!complete.ok) assert.fail(JSON.stringify(complete.issues));
  const serialized = serializeRegistryProviderConfig(complete.config);
  assert.deepEqual(serialized.excludedModelIds, ["Model"]);
  assert.deepEqual(serialized.builtinModelIds, ["Model"]);
  const personal = new ProviderConfigMap([
    ["personal", new ProviderConfig({ excludedModelIds: ["Model"] })],
  ]);
  assert.deepEqual(personal.toJSON()[0]?.config.excludedModelIds, ["Model"]);
});
