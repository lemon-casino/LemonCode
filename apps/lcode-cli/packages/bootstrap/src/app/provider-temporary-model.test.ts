import assert from "node:assert/strict";
import test from "node:test";
import type { AiSdkModelAdapter } from "@lcode/adapters/model";
import type { Model } from "@lcode/contracts";
import {
  ModelConfig,
  ModelConfigRules,
  ProviderConfigMap,
  ProviderConfigService,
  ProviderRegistryService,
  ProviderTemplateMap,
  parseProviderConfig,
  type AccountProviderStates,
  type ProviderConfigLayerSnapshot,
  type ProviderConfigObject,
} from "@lcode/provider";
import { ApiProviderModelRuntime } from "./provider-registry-model-runtime.js";

const completeModel = ModelConfig.fromData({
  enabled: true,
  properties: {
    requiresMfjsToolSchema: false,
    contextWindow: 8192,
    inputFormat: {
      supportsText: true,
      supportsImage: false,
      supportsVideo: false,
      supportsAudio: false,
      supportsPdf: false,
    },
    outputFormat: { supportsText: true },
    supportsToolCall: true,
    supportsJsonSchemaOutput: false,
    supportsNativeWebSearch: false,
    supportsMidConversationSystem: true,
  },
  optionSpecs: {
    reasoningLevel: { values: ["low", "high"], map: "{}" },
    maxOutputTokens: { max: 1024, map: "{}" },
    speed: { values: ["normal", "fast"], map: "{}" },
  },
});
const providerConfig: ProviderConfigObject = {
  group: "standard-personal",
  access: {
    type: "api-key",
    apiKey: "fixture-key",
    apiKeys: [{ id: "one", apiKey: "fixture-key", enabled: true }],
  },
  api: {
    type: "openai-chat-completions",
    baseUrl: "https://example.test/v1",
    headers: { "x-fixture": "preserved" },
  },
  personalModelIds: ["disabled", "published"],
};

type AdapterInput = Parameters<AiSdkModelAdapter["createModel"]>[0];

async function createHarness(
  options: {
    config?: ProviderConfigObject;
    enabled?: boolean;
    templateId?: string;
    accountStates?: AccountProviderStates;
    models?: ModelConfigRules;
  } = {},
) {
  let writes = 0;
  let reads = 0;
  const builtin: ProviderConfigLayerSnapshot = {
    revision: "builtin",
    providers: ProviderConfigMap.empty(),
    providerTemplates: ProviderTemplateMap.empty(),
    models:
      options.models ??
      new ModelConfigRules([
        { type: "model", modelMatch: ".*", config: completeModel },
        {
          type: "provider-site",
          modelMatch: ".*",
          baseUrlMatch: "https://example\\.test/v1",
          config: ModelConfig.fromData({ properties: { contextWindow: 16384 } }),
        },
      ]),
  };
  const personal: ProviderConfigLayerSnapshot = {
    revision: "personal",
    saveGenerations: { custom: "saved-once" },
    providers: new ProviderConfigMap([
      {
        providerId: "custom",
        enabled: options.enabled ?? true,
        ...(options.templateId ? { templateId: options.templateId } : {}),
        config: parseProviderConfig(options.config ?? providerConfig),
      },
    ]),
    models: new ModelConfigRules([
      {
        type: "provider-model",
        providerId: "custom",
        modelId: "disabled",
        config: ModelConfig.fromData({ enabled: false, properties: { contextWindow: 32768 } }),
      },
    ]),
  };
  const service = new ProviderConfigService({
    lcodeBuiltinSource: { read: async () => builtin, onDidChange: () => () => undefined },
    personalRepository: {
      read: async () => {
        reads += 1;
        return personal;
      },
      onDidChange: () => () => undefined,
      update: async () => {
        writes += 1;
        throw new Error("probe must not write configuration");
      },
    },
  });
  const registry = new ProviderRegistryService({
    configSource: service,
    accountSource: {
      read: async () => ({
        revision: "account",
        basedOnLCodeBuiltinRevision: "builtin",
        providers: ProviderConfigMap.empty(),
        states: options.accountStates,
      }),
      onDidChange: () => () => undefined,
    },
  });
  await registry.start();
  const creations: AdapterInput[] = [];
  const runtime = new ApiProviderModelRuntime({
    registry,
    modelAdapter: {
      createModel: (input) => {
        creations.push(input);
        return {} as Model;
      },
    },
  });
  runtime.start();
  return {
    registry,
    runtime,
    creations,
    personal,
    writes: () => writes,
    reads: () => reads,
    dispose: () => {
      runtime.dispose();
      registry.dispose();
      service.dispose();
    },
  };
}

test("temporary model uses official model rules without publishing, enabling or saving", async () => {
  const h = await createHarness();
  try {
    const before = h.registry.getSnapshot();
    const reads = h.reads();
    for (const modelId of [" unregistered ", "disabled"]) {
      h.runtime.temporaryModelFactory({ selection: { providerId: "custom", modelId } });
    }
    assert.equal(h.creations.length, 2);
    assert.equal(h.creations[0]?.modelId, "unregistered");
    assert.equal(h.creations[0]?.modelConfig.properties.contextWindow, 16384);
    assert.equal(h.creations[1]?.modelConfig.properties.contextWindow, 32768);
    assert.equal(h.creations[1]?.modelConfig.enabled, true);
    assert.deepEqual(h.creations[0]?.options, { reasoningLevel: "low", speed: "normal" });
    assert.deepEqual(h.creations[0]?.providerConfig.api.headers, { "x-fixture": "preserved" });
    const access = h.creations[0]?.providerConfig.access;
    assert.ok(access && access.type !== "zhipu-account");
    assert.deepEqual(
      access.apiKeys,
      providerConfig.access?.type === "api-key" ? providerConfig.access.apiKeys : undefined,
    );
    assert.equal(h.creations[0]?.providerSaveGeneration, "saved-once");
    assert.equal(h.registry.getSnapshot(), before);
    assert.equal(h.registry.getModel("custom", "unregistered"), undefined);
    assert.equal(h.registry.getModel("custom", "disabled"), undefined);
    assert.equal(h.personal.models.getExact("custom", "disabled")?.enabled, false);
    assert.equal(h.writes(), 0);
    assert.equal(
      h.reads(),
      reads,
      "temporary resolution reads the ready snapshot, not persistence",
    );
  } finally {
    h.dispose();
  }
});

test("a provider with zero published models remains eligible only for temporary probes", async () => {
  const h = await createHarness({ config: { ...providerConfig, personalModelIds: [] } });
  try {
    assert.equal(h.registry.getProvider("custom"), undefined);
    h.runtime.temporaryModelFactory({
      selection: { providerId: "custom", modelId: "unregistered" },
    });
    assert.equal(h.creations.length, 1);
    assert.throws(() =>
      h.runtime.modelFactory({
        selection: {
          providerId: "custom",
          modelId: "unregistered",
          options: { reasoningLevel: "low", speed: "normal" },
        },
      }),
    );
  } finally {
    h.dispose();
  }
});

test("excluded models may be probed without removing their persisted tombstone", async () => {
  const h = await createHarness({
    config: {
      ...providerConfig,
      builtinModelIds: ["deleted"],
      excludedModelIds: ["deleted"],
    },
  });
  try {
    const before = h.registry.getSnapshot();
    assert.equal(h.registry.getModel("custom", "deleted"), undefined);
    h.runtime.temporaryModelFactory({ selection: { providerId: "custom", modelId: "deleted" } });
    assert.equal(h.creations[0]?.modelId, "deleted");
    assert.equal(h.registry.getSnapshot(), before);
    assert.deepEqual(h.personal.providers.get("custom")?.excludedModelIds, ["deleted"]);
    assert.equal(h.writes(), 0);
  } finally {
    h.dispose();
  }
});

test("ordinary factory still rejects missing and disabled models and missing execution options", async () => {
  const h = await createHarness();
  try {
    for (const modelId of ["unregistered", "disabled"]) {
      assert.throws(() =>
        h.runtime.modelFactory({
          selection: {
            providerId: "custom",
            modelId,
            options: { reasoningLevel: "low", speed: "normal" },
          },
        }),
      );
    }
    assert.throws(() =>
      h.runtime.modelFactory({ selection: { providerId: "custom", modelId: "published" } }),
    );
    h.runtime.modelFactory({
      selection: {
        providerId: "custom",
        modelId: "published",
        options: { reasoningLevel: "high", speed: "fast" },
      },
    });
    assert.equal(h.creations.length, 1);
    assert.deepEqual(h.creations[0]?.options, { reasoningLevel: "high", speed: "fast" });
  } finally {
    h.dispose();
  }
});

test("temporary probes fail closed on provider eligibility and incomplete model rules", async () => {
  const account = {
    ...providerConfig,
    access: {
      type: "zhipu-account",
      accountType: "zai",
      mode: "individual-coding-plan",
      entitled: true,
    },
  } as const;
  const cases = [
    { enabled: false },
    { config: { ...providerConfig, api: null } },
    { config: { ...providerConfig, access: { type: "api-key", apiKey: "" } } },
    {
      config: {
        ...providerConfig,
        access: {
          type: "api-key",
          apiKey: "stale-legacy",
          apiKeys: [{ id: "off", apiKey: "fixture", enabled: false }],
        },
      },
    },
    { templateId: "missing-template" },
    { config: { ...account, access: { ...account.access, entitled: false } } },
    {
      config: account,
      accountStates: { custom: { availability: "available", entitled: true, current: false } },
    },
    { models: ModelConfigRules.empty() },
  ] satisfies Parameters<typeof createHarness>[0][];
  for (const options of cases) {
    const h = await createHarness(options);
    try {
      assert.throws(() =>
        h.runtime.temporaryModelFactory({
          selection: { providerId: "custom", modelId: "unregistered" },
        }),
      );
      assert.equal(h.creations.length, 0);
      assert.equal(h.writes(), 0);
    } finally {
      h.dispose();
    }
  }
});
