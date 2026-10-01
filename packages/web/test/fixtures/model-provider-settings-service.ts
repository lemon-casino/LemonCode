import {
  ModelConfigRules,
  ProviderConfigMap,
  ProviderConfigService,
  ProviderRegistryService,
  ProviderSettingsFacade,
  ProviderTemplate,
  ProviderTemplateMap,
  extractManualModelConfig,
  isApiKeyAccess,
  parseModelConfig,
  parsePersonalModelConfigRules,
  parsePersonalProviderConfigMap,
  parseProviderConfig,
  resolveApiKeyAccessKeys,
  type PersonalProviderConfigRepository,
  type ProviderConfigLayerSnapshot,
  type ProviderConfigLayerUpdate,
  type ProviderSettingsMutationTarget,
} from "../../../provider/src/index.js";
// Web 未声明此包依赖且夹具不能改 manifest；上面显式引用 @lcode/provider exports["."] 的公开入口。
import type { IProviderSettingsService } from "@lcode/services";
import type { ModelConnectivityResult } from "@lcode/shared";

export const STORAGE_KEY = "lcode-test-model-provider-settings-fixture-v1";
export const PROVIDER_ID = "test";
const TEMPLATE_ID = "test-template";
const BUILTIN_REVISION = "fixture-template-v1";
const remoteIds = [
  " remote-a ",
  "remote-a",
  "remote-b",
  "bad-model",
  "throws-model",
  ...Array.from({ length: 8 }, (_, index) => `good-${index + 1}`),
  "builtin-a",
  "disabled-a",
];
const recommended = parseModelConfig({
  enabled: true,
  properties: {
    requiresMfjsToolSchema: false,
    contextWindow: 128_000,
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
    supportsMidConversationSystem: false,
  },
  optionSpecs: {
    reasoningLevel: { values: ["low", "high"], map: "{}" },
    maxOutputTokens: { max: 8192, map: "{}" },
  },
});
const builtin: ProviderConfigLayerSnapshot = {
  revision: BUILTIN_REVISION,
  providers: ProviderConfigMap.empty(),
  providerTemplates: new ProviderTemplateMap([
    [
      TEMPLATE_ID,
      new ProviderTemplate({
        templateId: TEMPLATE_ID,
        templateNameMap: { "zh-CN": "测试模板", "en-US": "Test template" },
        config: parseProviderConfig({
          api: { type: "openai-chat-completions", baseUrl: "https://provider.fixture.invalid/v1" },
          access: { type: "api-key" },
          builtinModelIds: ["builtin-a", "disabled-a"],
        }),
      }),
    ],
  ]),
  models: new ModelConfigRules([{ type: "model", modelMatch: ".*", config: recommended }]),
};
const initial: ProviderConfigLayerUpdate = {
  providers: new ProviderConfigMap([
    {
      providerId: PROVIDER_ID,
      providerName: "Test Provider",
      templateId: TEMPLATE_ID,
      config: parseProviderConfig({
        group: "standard-personal",
        access: { type: "api-key", apiKey: "FIXTURE_ONLY_NOT_A_REAL_API_KEY" },
        personalModelIds: ["local-only", "invalid-model", "uncertain-model"],
        modelOrder: ["builtin-a", "disabled-a", "local-only", "invalid-model", "uncertain-model"],
      }),
    },
  ]),
  models: ModelConfigRules.empty()
    .setExact(PROVIDER_ID, "disabled-a", parseModelConfig({ enabled: false }), true)
    .setExact(
      PROVIDER_ID,
      "local-only",
      parseModelConfig(
        extractManualModelConfig({
          ...recommended.toJSON(),
          properties: { ...recommended.toJSON().properties, contextWindow: 65_536 },
          optionSpecs: { ...recommended.toJSON().optionSpecs, maxOutputTokens: { max: 4096 } },
        }),
      ),
      false,
    ),
  providerOrder: [PROVIDER_ID],
};

// 仅保存夹具私有格式；用公开领域 parser 往返，不能把 Node 文件 codec 带进浏览器。
function encode(update: ProviderConfigLayerUpdate, saveGenerations = {}) {
  return JSON.stringify({
    providers: update.providers.toJSON(),
    models: update.models.toPersonalJSON(),
    providerOrder: update.providerOrder ?? [],
    defaultModelSelection: update.defaultModelSelection,
    saveGenerations,
  });
}
function decode(serialized: string): ProviderConfigLayerSnapshot {
  const data = JSON.parse(serialized) as {
    providers: unknown;
    models: unknown;
    providerOrder: string[];
    defaultModelSelection?: ProviderConfigLayerSnapshot["defaultModelSelection"];
    saveGenerations?: Readonly<Record<string, string>>;
  };
  return {
    providers: parsePersonalProviderConfigMap({ providerRules: data.providers }),
    models: parsePersonalModelConfigRules(data.models),
    providerOrder: data.providerOrder,
    defaultModelSelection: data.defaultModelSelection,
    saveGenerations: data.saveGenerations,
    revision: JSON.stringify([data.providers, data.models, data.providerOrder]),
  };
}
interface Metrics {
  catalogLoads: number;
  started: number;
  active: number;
  maxActive: number;
  mutations: number;
  pending: number;
  held: boolean;
  logs: readonly string[];
}

function createFixture() {
  let metrics: Metrics = {
    catalogLoads: 0,
    started: 0,
    active: 0,
    maxActive: 0,
    mutations: 0,
    pending: 0,
    held: false,
    logs: [],
  };
  const listeners = new Set<() => void>();
  const probeListeners = new Set<() => void>();
  const pending: Array<() => void> = [];
  const publish = (patch: Partial<Metrics>, message?: string) => {
    metrics = { ...metrics, ...patch, logs: message ? [...metrics.logs, message] : metrics.logs };
    listeners.forEach((listener) => listener());
  };
  const record = (message: string) => publish({}, message);
  const repository: PersonalProviderConfigRepository = {
    async read() {
      return decode(sessionStorage.getItem(STORAGE_KEY) ?? encode(initial));
    },
    onDidChange: () => () => undefined,
    async update(transform) {
      const current = await repository.read();
      const update = transform(current);
      const generations = { ...current.saveGenerations };
      if (update.savedProviderId) {
        generations[update.savedProviderId] = String(
          Number(generations[update.savedProviderId] ?? 0) + 1,
        );
      }
      const serialized = encode(update, generations);
      const accepted = decode(serialized);
      sessionStorage.setItem(STORAGE_KEY, serialized);
      const provider = accepted.providers.get(PROVIDER_ID);
      publish(
        { mutations: metrics.mutations + 1 },
        `persist #${metrics.mutations + 1} provider=${update.savedProviderId ?? "order"}` +
          ` personal=${JSON.stringify(provider?.personalModelIds ?? [])}` +
          ` excluded=${JSON.stringify(provider?.excludedModelIds ?? [])}`,
      );
      return accepted;
    },
  };
  const config = new ProviderConfigService({
    lcodeBuiltinSource: { read: async () => builtin, onDidChange: () => () => undefined },
    personalRepository: repository,
  });
  const registry = new ProviderRegistryService({
    configSource: config,
    accountSource: {
      read: async () => ({
        revision: "fixture-no-account",
        basedOnLCodeBuiltinRevision: BUILTIN_REVISION,
        providers: ProviderConfigMap.empty(),
      }),
      onDidChange: () => () => undefined,
    },
  });
  const target: ProviderSettingsMutationTarget = {
    createPersonalProvider: (...args) => config.createPersonalProvider(...args),
    savePersonalProviderOverlay: (...args) => config.savePersonalProviderOverlay(...args),
    deletePersonalProvider: (...args) => config.deletePersonalProvider(...args),
    reorderPersonalProviders: (...args) => config.reorderPersonalProviders(...args),
    reorderPersonalModels: (...args) => config.reorderPersonalModels(...args),
    addPersonalModel: (...args) => config.addPersonalModel(...args),
    renamePersonalModel: (...args) => config.renamePersonalModel(...args),
    deletePersonalModel: (...args) => config.deletePersonalModel(...args),
    savePersonalModelDraft: (...args) => config.savePersonalModelDraft(...args),
    setPersonalModelEnabled: (...args) => config.setPersonalModelEnabled(...args),
    refresh: (reason) => registry.refresh(reason),
  };
  const facade = new ProviderSettingsFacade(registry, target);
  const ready = registry.start();
  void ready.catch(() => record("configuration load failed; use Reset to recover"));
  const mutate = async <T>(label: string, operation: () => Promise<T>): Promise<T> => {
    await ready;
    record(`mutation ${label}`);
    return operation();
  };
  const providerView = async (providerId: string) => {
    await ready;
    await facade.waitForProviderOperations(providerId);
    const provider = facade.getView().providers.find((item) => item.providerId === providerId);
    if (!provider) throw new Error(`Fixture provider missing: ${providerId}`);
    return provider;
  };
  const service: IProviderSettingsService = {
    onDidChange: (listener) => ({ dispose: facade.onDidChange(listener) }),
    getView: async () => {
      await ready;
      return facade.getView();
    },
    refresh: async (reason) => {
      await ready;
      record(`reload ${reason}`);
      return facade.refresh(reason);
    },
    resolveModelConfig: async (input) => {
      await ready;
      return facade.resolveModelConfig(input);
    },
    createPersonalProvider: (input) =>
      mutate("create-provider", () => facade.createPersonalProvider(input)),
    savePersonalProviderOverlay: (id, value, metadata) =>
      mutate(`save-provider ${id}`, () => facade.savePersonalProviderOverlay(id, value, metadata)),
    deletePersonalProvider: (id) =>
      mutate(`delete-provider ${id}`, () => facade.deletePersonalProvider(id)),
    reorderPersonalProviders: (ids) =>
      mutate("reorder-providers", () => facade.reorderPersonalProviders(ids)),
    reorderPersonalModels: (id, ids) =>
      mutate(`reorder-models ${id}`, () => facade.reorderPersonalModels(id, ids)),
    addPersonalModel: (id, model, value, recommended) =>
      mutate(`add-model ${id}/${model}`, () =>
        facade.addPersonalModel(id, model, value, recommended),
      ),
    renamePersonalModel: (id, from, to) =>
      mutate(`rename-model ${id}/${from} -> ${to}`, () => facade.renamePersonalModel(id, from, to)),
    deletePersonalModel: (id, model) =>
      mutate(`delete-model ${id}/${model}`, () => facade.deletePersonalModel(id, model)),
    savePersonalModelDraft: (input) =>
      mutate(`save-model ${input.providerId}/${input.nextModelId}`, () =>
        facade.savePersonalModelDraft(input),
      ),
    setPersonalModelEnabled: (id, model, enabled) =>
      mutate(`enable-model ${id}/${model}=${enabled}`, () =>
        facade.setPersonalModelEnabled(id, model, enabled),
      ),
    async listRemoteModels(providerId) {
      await providerView(providerId);
      publish({ catalogLoads: metrics.catalogLoads + 1 }, `catalog ${providerId} (simulated)`);
      return { models: [...remoteIds] };
    },
    async probeApiKeys(providerId, keyIds) {
      const provider = await providerView(providerId);
      const access = provider.effectiveConfig.access;
      if (!isApiKeyAccess(access)) throw new Error("Fixture provider requires API Key access");
      return resolveApiKeyAccessKeys(access)
        .filter((key) => !keyIds?.length || keyIds.includes(key.id))
        .map((key) => {
          record(`probe-key ${key.id} valid (simulated; secret omitted)`);
          return { keyId: key.id, status: "valid" as const };
        });
    },
    async testModelConnectivity(input): Promise<ModelConnectivityResult> {
      const provider = await providerView(input.providerId);
      const temporary = input.mode === "temporary";
      if (!provider.enabled || !provider.executable) {
        return {
          success: false,
          error: { code: "provider-unavailable", message: "Fixture provider unavailable" },
        };
      }
      const resolved = facade.resolveModelConfig({
        providerId: input.providerId,
        modelId: input.modelId,
      });
      if (
        resolved.issues.length ||
        (!temporary && !registry.getModel(input.providerId, input.modelId))
      ) {
        return {
          success: false,
          error: { code: "model-unavailable", message: "Fixture model unavailable" },
        };
      }
      const sequence = metrics.started + 1;
      const identity = `${input.providerId}/${input.modelId} mode=${input.mode ?? "default"}`;
      // 挂起先于通知；卸载预设不依赖定时器，也不在夹具中代替真实 UI 的取消判断。
      const wait = metrics.held
        ? new Promise<void>((resolve) => pending.push(resolve))
        : Promise.resolve();
      publish(
        {
          started: sequence,
          active: metrics.active + 1,
          maxActive: Math.max(metrics.maxActive, metrics.active + 1),
          pending: pending.length,
        },
        `probe #${sequence} start ${identity}`,
      );
      try {
        probeListeners.forEach((listener) => listener());
        await wait;
        if (input.modelId === "throws-model") {
          record(`probe #${sequence} throws ${identity}`);
          throw new Error("Fixture probe threw (simulated network failure)");
        }
        if (input.modelId === "bad-model") {
          record(`probe #${sequence} HTTP 403 ${identity}`);
          return {
            success: false,
            error: { message: "HTTP 403: fixture access denied (simulated)" },
          };
        }
        if (input.modelId === "invalid-model") {
          record(`probe #${sequence} model-not-found ${identity}`);
          return {
            success: false,
            error: { code: "model-not-found", message: "Fixture provider confirms model missing" },
          };
        }
        if (input.modelId === "uncertain-model") {
          record(`probe #${sequence} HTTP 503 ${identity}`);
          return {
            success: false,
            error: { message: "HTTP 503: fixture unavailable (simulated)" },
          };
        }
        record(`probe #${sequence} success ${identity}`);
        return { success: true };
      } finally {
        publish({ active: metrics.active - 1 });
      }
    },
  };
  return {
    service,
    record,
    snapshot: () => metrics,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onProbeStarted(listener: () => void) {
      probeListeners.add(listener);
      return () => {
        probeListeners.delete(listener);
      };
    },
    setHeld(held: boolean) {
      publish({ held }, `hold=${held}`);
    },
    releaseOne() {
      const resolve = pending.shift();
      publish({ pending: pending.length }, `release-one ${resolve ? 1 : 0}`);
      resolve?.();
    },
    release() {
      const requests = pending.splice(0);
      publish({ held: false, pending: 0 }, `release-all ${requests.length}`);
      requests.forEach((resolve) => resolve());
    },
    reset() {
      sessionStorage.removeItem(STORAGE_KEY);
    },
  };
}

export const fixture = createFixture();
