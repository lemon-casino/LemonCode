import type { TestContext } from "node:test";
import {
  ModelConfigRules,
  ProviderConfig,
  ProviderConfigMap,
  ProviderConfigService,
  ProviderRegistryService,
  ProviderSettingsFacade,
  ProviderTemplate,
  ProviderTemplateMap,
  extractManualModelConfig,
  parseModelConfig,
  parseProviderConfig,
  type PersonalProviderConfigRepository,
  type ProviderConfigLayerSnapshot,
  type ProviderConfigLayerUpdate,
} from "../src/index.js";
import {
  decodeProviderConfigFile,
  encodeProviderConfigFile,
} from "../../provider-node/src/index.js";

export const completeModelConfig = parseModelConfig({
  enabled: true,
  properties: {
    requiresMfjsToolSchema: false,
    contextWindow: 128_000,
    inputFormat: {
      supportsText: true,
      supportsImage: true,
      supportsVideo: false,
      supportsAudio: false,
      supportsPdf: false,
    },
    outputFormat: { supportsText: true },
    supportsToolCall: true,
    supportsJsonSchemaOutput: false,
    supportsNativeWebSearch: false,
    supportsMidConversationSystem: false,
  },
  optionSpecs: {
    reasoningLevel: { values: ["low", "high"], map: "{}" },
    maxOutputTokens: { max: 8192, map: "{}" },
  },
});
export const manualModelConfig = parseModelConfig(
  extractManualModelConfig(completeModelConfig.toJSON()),
);
export const defaultSelection = { providerId: "template", modelId: "Base" };

export function roundtrip(update: ProviderConfigLayerUpdate): ProviderConfigLayerUpdate {
  return decodeProviderConfigFile(JSON.parse(JSON.stringify(encodeProviderConfigFile(update))));
}

// 用真实文件 codec 模拟 Repository 的原子提交，避免测试绕过个人来源 schema。
class MemoryRepository implements PersonalProviderConfigRepository {
  readonly updates: ProviderConfigLayerUpdate[] = [];
  snapshot: ProviderConfigLayerSnapshot;

  constructor(update: ProviderConfigLayerUpdate) {
    const canonical = roundtrip(update);
    this.snapshot = {
      ...canonical,
      revision: JSON.stringify(encodeProviderConfigFile(canonical)),
      saveGenerations: { other: "untouched-generation" },
    };
  }

  async read(): Promise<ProviderConfigLayerSnapshot> {
    return this.snapshot;
  }

  onDidChange(): () => void {
    return () => undefined;
  }

  async update(
    transform: (current: ProviderConfigLayerSnapshot) => ProviderConfigLayerUpdate,
  ): Promise<ProviderConfigLayerSnapshot> {
    const update = transform(this.snapshot);
    const canonical = roundtrip(update);
    this.updates.push(update);
    this.snapshot = {
      ...canonical,
      revision: JSON.stringify(encodeProviderConfigFile(canonical)),
      saveGenerations: {
        ...this.snapshot.saveGenerations,
        ...(update.savedProviderId
          ? { [update.savedProviderId]: String(this.updates.length) }
          : {}),
      },
    };
    return this.snapshot;
  }
}

export async function createMembershipFixture(t: TestContext) {
  const api = { type: "openai-chat-completions", baseUrl: "https://example.test/v1" };
  const access = { type: "api-key", apiKey: "test-key" };
  const builtin = {
    snapshot: {
      revision: "builtin-1",
      providers: new ProviderConfigMap([
        [
          "builtin",
          parseProviderConfig({
            group: "zai-family",
            api,
            access,
            builtinModelIds: ["Base", "Other"],
          }),
        ],
        [
          "account:test",
          parseProviderConfig({
            group: "zai-family",
            api,
            builtinModelIds: ["Static"],
            access: {
              type: "zhipu-account",
              accountType: "zai",
              mode: "start-plan",
              entitled: true,
            },
          }),
        ],
      ]),
      providerTemplates: new ProviderTemplateMap([
        [
          "definition",
          new ProviderTemplate({
            templateId: "definition",
            templateNameMap: { "en-US": "Example" },
            config: parseProviderConfig({
              api,
              access: { type: "api-key" },
              builtinModelIds: ["Base", "TemplateOnly"],
            }),
          }),
        ],
      ]),
      models: new ModelConfigRules([
        { type: "model", modelMatch: ".*", config: completeModelConfig },
      ]),
    } satisfies ProviderConfigLayerSnapshot,
    async read() {
      return this.snapshot;
    },
    onDidChange() {
      return () => undefined;
    },
  };
  const repository = new MemoryRepository({
    providers: new ProviderConfigMap([
      {
        providerId: "template",
        templateId: "definition",
        config: parseProviderConfig({
          group: "standard-personal",
          access,
          personalModelIds: ["Custom"],
          modelOrder: ["Custom", "TemplateOnly", "Base"],
        }),
      },
      {
        providerId: "personal",
        config: parseProviderConfig({
          group: "standard-personal",
          api,
          access,
          personalModelIds: ["Custom", "custom", "Custom-v2"],
          modelOrder: ["Custom-v2", "Custom", "custom"],
        }),
      },
      {
        providerId: "other",
        config: parseProviderConfig({
          group: "standard-personal",
          api,
          access,
          personalModelIds: ["Custom"],
        }),
      },
    ]),
    models: ModelConfigRules.empty(),
    providerOrder: ["template", "personal", "other"],
    defaultModelSelection: defaultSelection,
  });
  const service = new ProviderConfigService({
    lcodeBuiltinSource: builtin,
    personalRepository: repository,
  });
  const account = { providers: ProviderConfigMap.empty() };
  const registry = new ProviderRegistryService({
    configSource: service,
    accountSource: {
      read: async () => ({
        revision: JSON.stringify([builtin.snapshot.revision, account.providers.toJSON()]),
        basedOnLCodeBuiltinRevision: builtin.snapshot.revision,
        providers: account.providers,
      }),
      onDidChange: () => () => undefined,
    },
  });
  const target = new Proxy(service, {
    get(object, property) {
      if (property === "refresh") return registry.refresh.bind(registry);
      const value = Reflect.get(object, property);
      return typeof value === "function" ? value.bind(object) : value;
    },
  }) as ProviderConfigService & { refresh: ProviderRegistryService["refresh"] };
  const settings = new ProviderSettingsFacade(registry, target);
  t.after(() => {
    registry.dispose();
    service.dispose();
  });
  await registry.start();
  return {
    repository,
    service,
    builtin,
    account,
    registry,
    settings,
    ids: (providerId: string) =>
      settings
        .getView()
        .providers.find((item) => item.providerId === providerId)
        ?.models.map((model) => model.modelId) ?? [],
    async overlay(providerId: string, config: ProviderConfig) {
      await repository.update((current) => ({
        ...current,
        providers: current.providers.set(
          providerId,
          (current.providers.get(providerId) ?? new ProviderConfig()).overlay(config),
        ),
      }));
      await registry.refresh("test-overlay");
    },
  };
}
