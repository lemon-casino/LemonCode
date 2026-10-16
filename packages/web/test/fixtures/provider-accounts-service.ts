import { projectFixtureAuthorizationDiagnostic } from "./provider-authorization-diagnostic-fixture.js";
import type { ProxyProfile } from "@lcode/shared";
import { applyProxyFixtureView, createProxyFixtureMethods } from "./provider-proxy-fixture.js";
import { fixtureAuthorizationChannels } from "./provider-authorization-catalog.js";
import { createCheckinFixture } from "./provider-checkin-fixture.js";
import type {
  ProviderAccount,
  ProviderAccountView,
  ProviderAuthorization,
  StartProviderAuthorization,
} from "@lcode/shared";
import type {
  IProviderAccountService,
  IServiceAccessor,
  ProviderSettingsView,
} from "@lcode/services";
import type {
  ProviderConfigObject,
  ModelConfigObject,
  SavePersonalModelDraftInput,
} from "../../../provider/src/index.js";
const listeners = new Set<(view: ProviderAccountView) => unknown>();
const settingsListeners = new Set<(view: ProviderSettingsView) => unknown>();
export const navigationScenario = new URLSearchParams(location.search).has("navigation");
export const scrollScenario = new URLSearchParams(location.search).has("scroll");
export const fixture = {
  accounts: [] as ProviderAccount[],
  opened: [] as string[],
  cancelled: [] as string[],
  refreshes: [] as string[],
  checkins: [] as string[],
  apiCreates: [] as string[],
  failNextCancel: false,
  failNextPoll: false,
  completeOnPoll: false,
  startFailure: null as string | null,
  completionFailure: null as string | null,
  authorizationInstructions: null as string | null,
  authorizationDiagnostic: undefined as ProviderAuthorization["diagnostic"],
  starts: [] as StartProviderAuthorization[],
  localReads: 0,
  importReads: 0,
  alternateHostReads: 0,
  apiCatalogReads: 0,
  switchHost: () => {},
  modelSaves: [] as SavePersonalModelDraftInput[],
  modelEnabled: true,
  proxyProfiles: [] as ProxyProfile[],
  proxyNetworks: {} as Record<string, ProviderConfigObject["network"]>,
  apiConfig: { apiKey: "fixture-existing-key", model: "fixture-existing-model", enabled: false },
};
Object.assign(window, { __providerAccounts: fixture });
let revision = 0;
let attemptNumber = 0;
let accountNumber = 0;
if (navigationScenario) {
  fixture.accounts = Array.from({ length: scrollScenario ? 20 : 2 }, (_, index) => index + 1).map(
    (number) => ({
      connectionId: `account-${number}`,
      channelId: "fixture",
      displayName: `Fixture Account ${number}`,
      enabled: true,
      status: "ready",
      authorizationStatus: "renewed",
      models: [{ id: "fixture-model", name: "Fixture Model", protocol: "openai-responses" }],
    }),
  );
  accountNumber = fixture.accounts.length;
}
const attempts = new Map<string, ProviderAuthorization>();
const view = (): ProviderAccountView => ({
  revision,
  channels: fixtureAuthorizationChannels,
  accounts: fixture.accounts,
});
function publish() {
  revision++;
  const next = view();
  for (const listener of listeners) listener(next);
  for (const listener of settingsListeners) listener(settingsView());
  return next;
}
export const service: IProviderAccountService = {
  onDidChange: (listener) => {
    listeners.add(listener);
    return { dispose: () => listeners.delete(listener) };
  },
  getView: async () => view(),
  ...createCheckinFixture(fixture, publish),
  getQuota: async (connectionId) => ({
    connectionId,
    source: "upstream",
    status: "unsupported",
    stale: false,
    windows: [],
  }),
  async startAuthorization({ channelId, methodId, inputs }) {
    fixture.starts.push({ channelId, methodId, inputs });
    if (fixture.startFailure) {
      const error = fixture.startFailure;
      fixture.startFailure = null;
      throw new Error(error);
    }
    const attempt: ProviderAuthorization = {
      attemptId: `attempt-${++attemptNumber}`,
      channelId,
      methodId,
      status: "pending",
      method: "code",
      diagnostic: fixture.authorizationDiagnostic,
      url: "https://example.test/authorize",
      instructions: fixture.authorizationInstructions ?? "Fixture browser authorization",
    };
    attempts.set(attempt.attemptId, attempt);
    if (methodId === "file") {
      fixture.importReads++;
      const files = JSON.parse(inputs?.files ?? "[]") as Array<{ name: string; content: string }>;
      const results: NonNullable<ProviderAuthorization["results"]>[number][] = [];
      for (const [index, file] of files.entries()) {
        let name: string;
        try {
          name = (JSON.parse(file.content) as { name: string }).name;
          if (!name) throw new Error("invalid");
        } catch {
          results.push({ index, label: file.name, status: "failed", error: "invalid_credentials" });
          continue;
        }
        const existing = fixture.accounts.find((account) => account.displayName === name);
        if (existing) {
          results.push({
            index,
            label: name,
            status: "exists",
            connectionId: existing.connectionId,
          });
          continue;
        }
        const connectionId = `account-${++accountNumber}`;
        fixture.accounts.push({
          connectionId,
          channelId,
          displayName: name,
          enabled: true,
          status: "ready",
          models: [],
        });
        results.push({ index, label: name, status: "added", connectionId });
      }
      const completed = { ...attempt, status: "completed" as const, results };
      attempts.set(attempt.attemptId, completed);
      publish();
      return completed;
    }
    if (methodId === "local") {
      fixture.localReads++;
      return service.completeAuthorization(attempt.attemptId, "fixture-local");
    }
    return attempt;
  },
  async getAuthorization(id) {
    if (fixture.failNextPoll) {
      fixture.failNextPoll = false;
      throw new Error("fixture network failure");
    }
    if (fixture.completeOnPoll) {
      fixture.completeOnPoll = false;
      return service.completeAuthorization(id, "fixture-polled-code");
    }
    const attempt = projectFixtureAuthorizationDiagnostic(
      attempts.get(id)!,
      fixture.authorizationDiagnostic,
    );
    attempts.set(id, attempt);
    return attempt;
  },
  async completeAuthorization(id, code) {
    const attempt = attempts.get(id)!;
    if (attempt.status !== "pending" || !code) return attempt;
    if (fixture.completionFailure) {
      const failed = {
        ...attempt,
        diagnostic: fixture.authorizationDiagnostic,
        status: "failed" as const,
        error: fixture.completionFailure,
      };
      fixture.completionFailure = null;
      attempts.set(id, failed);
      return failed;
    }
    const connectionId = `account-${++accountNumber}`;
    fixture.accounts = [
      ...fixture.accounts,
      {
        connectionId,
        channelId: attempt.channelId,
        displayName: `Fixture Account ${accountNumber}`,
        enabled: true,
        status: "ready",
        models: [
          {
            id: "fixture-model",
            name: "Fixture Model",
            protocol: "openai-responses",
            contextWindow: 128000,
          },
        ],
      },
    ];
    const completed = {
      ...attempt,
      diagnostic: fixture.authorizationDiagnostic,
      status: "completed" as const,
      connectionId,
    };
    attempts.set(id, completed);
    publish();
    return completed;
  },
  async cancelAuthorization(id) {
    if (fixture.failNextCancel) {
      fixture.failNextCancel = false;
      throw new Error("fixture network failure");
    }
    fixture.cancelled.push(id);
    const cancelled = { ...attempts.get(id)!, status: "cancelled" as const };
    attempts.set(id, cancelled);
    return cancelled;
  },
  async refreshModels(id) {
    fixture.refreshes.push(id);
    return publish();
  },
  async removeAccount(id) {
    fixture.accounts = fixture.accounts.filter((account) => account.connectionId !== id);
    return publish();
  },
  async setAccountEnabled(id, enabled) {
    fixture.accounts = fixture.accounts.map((account) =>
      account.connectionId === id ? { ...account, enabled } : account,
    );
    return publish();
  },
};
export const templates: ProviderSettingsView["providerTemplates"] = [
  {
    templateId: "fixture-api",
    templateNameMap: { "zh-CN": "Fixture API", "en-US": "Fixture API" },
    config: {
      group: "standard-personal",
      access: { type: "api-key" },
      api: { type: "openai-chat-completions", baseUrl: "https://example.test/v1" },
    },
  },
];
const modelDefaults: ModelConfigObject = {
  properties: {
    contextWindow: 128000,
    interactionProtocol: "native-tool-calls",
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
    maxOutputTokens: { max: 8192, map: "{}" },
    reasoningLevel: { values: ["low", "high"], map: "{}" },
  },
};
let personalModelConfig: ModelConfigObject = {};
function effectiveModelConfig(): ModelConfigObject {
  return {
    ...modelDefaults,
    ...personalModelConfig,
    enabled: fixture.modelEnabled,
    properties: {
      ...modelDefaults.properties,
      ...personalModelConfig.properties,
      inputFormat: {
        ...modelDefaults.properties?.inputFormat,
        ...personalModelConfig.properties?.inputFormat,
      },
    },
    optionSpecs: { ...modelDefaults.optionSpecs, ...personalModelConfig.optionSpecs },
  };
}
function settingsView(): ProviderSettingsView {
  const enabled = fixture.accounts.some((account) => account.enabled);
  const scrollProviders: ProviderSettingsView["providers"] = scrollScenario
    ? Array.from({ length: 40 }, (_, index) => ({
        providerId: `scroll-api-${index + 1}`,
        providerName: `Fixture API ${index + 1}`,
        enabled: true,
        executable: true,
        issues: [],
        personalConfig: {
          group: "standard-personal",
          access: { type: "api-key", apiKey: "fixture-key" },
          api: { type: "openai-chat-completions", baseUrl: "https://example.test/v1" },
        },
        effectiveConfig: {
          group: "standard-personal",
          access: { type: "api-key", apiKey: "fixture-key" },
          api: { type: "openai-chat-completions", baseUrl: "https://example.test/v1" },
        },
        models: Array.from({ length: 24 }, (_, modelIndex) => ({
          kind: "candidate",
          modelId: `scroll-model-${modelIndex + 1}`,
          builtin: true,
          effectiveBuiltinConfig: modelDefaults,
          personalExactConfig: {},
          effectiveConfig: modelDefaults,
          enabled: true,
          executable: true,
          selectable: true,
          issues: [],
        })),
      }))
    : [];
  const view: ProviderSettingsView = {
    revision,
    providerTemplates: templates,
    providerOrder: [],
    providers: fixture.accounts.length
      ? [
          ...scrollProviders,
          {
            providerId: "oauth_fixture_openai-responses",
            providerName: "Fixture OAuth pool",
            enabled,
            executable: enabled,
            issues: [],
            models: [
              {
                kind: "candidate",
                modelId: "fixture-model",
                builtin: true,
                effectiveBuiltinConfig: modelDefaults,
                personalExactConfig: personalModelConfig,
                effectiveConfig: effectiveModelConfig(),
                enabled: fixture.modelEnabled,
                executable: enabled && fixture.modelEnabled,
                selectable: enabled && fixture.modelEnabled,
                issues: [],
              },
            ],
            effectiveConfig: {
              group: "standard-personal",
              enabled,
              access: { type: "oauth-account", channelId: "fixture" },
            },
            // Account Provider Source 没有 personalConfig；真实 projection/navigation 必须保留它。
          },
        ]
      : scrollProviders,
  };
  return applyProxyFixtureView(view, fixture);
}
export const services = {
  providerAccountService: service,
  providerSettingsService: {
    ...createProxyFixtureMethods(fixture, settingsView, publish),
    async setProviderNetwork(providerId: string, network: ProviderConfigObject["network"]) {
      fixture.proxyNetworks[providerId] = network;
      publish();
      return settingsView();
    },
    getView: async () => settingsView(),
    listRemoteModels: async () => {
      fixture.apiCatalogReads++;
      throw new Error("OAuth must not use the API key catalog");
    },
    resolveModelConfig: async () => ({
      inheritedConfig: modelDefaults,
      effectiveConfig: effectiveModelConfig(),
      issues: [],
    }),
    async savePersonalModelDraft(input: SavePersonalModelDraftInput) {
      fixture.modelSaves.push(input);
      personalModelConfig = input.personalConfig;
      publish();
      return settingsView();
    },
    async setPersonalModelEnabled(_providerId: string, _modelId: string, enabled: boolean) {
      fixture.modelEnabled = enabled;
      publish();
      return settingsView();
    },
    onDidChange: (listener: (view: ProviderSettingsView) => unknown) => {
      settingsListeners.add(listener);
      return { dispose: () => settingsListeners.delete(listener) };
    },
  },
} as IServiceAccessor;
