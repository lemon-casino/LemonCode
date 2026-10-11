import {
  ModelConfig,
  ModelConfigRules,
  ProviderConfigMap,
  parseProviderConfig,
  type AccountProviderConfigSnapshot,
  type ProviderSource,
  type ModelConfigRule,
} from "@lcode/provider";
import type { ProviderAccounts } from "./providerAccounts.js";
import {
  createAuthModelOptionSpecs,
  type AuthModel,
  type AuthWireProtocol,
} from "@lcode/provider-node";

export function oauthProviderId(channelId: string): string {
  return `oauth:${channelId}`;
}
export function createProviderAccountsSource(
  base: ProviderSource<AccountProviderConfigSnapshot> & {
    refresh(reason: string): Promise<AccountProviderConfigSnapshot>;
  },
  accounts: ProviderAccounts,
) {
  async function project(
    snapshot: AccountProviderConfigSnapshot,
  ): Promise<AccountProviderConfigSnapshot> {
    let providers = snapshot.providers;
    const rules: ModelConfigRule[] = [];
    const pools = new Map<
      string,
      {
        channelId: string;
        name: string;
        protocol: AuthWireProtocol;
        models: Map<string, AuthModel>;
      }
    >();
    for (const account of await accounts.readAccounts()) {
      const id = oauthProviderId(account.channelId);
      let pool = pools.get(id);
      if (!pool) {
        pool = {
          channelId: account.channelId,
          name: accounts.channelName(account.channelId),
          protocol: account.models[0]?.protocol ?? "openai-chat-completions",
          models: new Map(),
        };
        pools.set(id, pool);
      }
      for (const model of account.models) {
        if (account.enabled && !pool.models.has(model.id)) pool.models.set(model.id, model);
      }
    }
    for (const [providerId, pool] of pools) {
      providers = providers.setRule({
        providerId,
        providerName: pool.name,
        enabled: pool.models.size > 0,
        config: parseProviderConfig({
          group: "standard-personal",
          access: { type: "oauth-account", channelId: pool.channelId },
          api: { type: pool.protocol, baseUrl: "https://oauth.invalid/v1" },
          builtinModelIds: [...pool.models.keys()],
        }),
      });
      for (const [modelId, model] of pool.models)
        rules.push({
          type: "provider-model",
          providerId,
          modelId,
          config: ModelConfig.fromData({
            enabled: true,
            properties: {
              requiresMfjsToolSchema: false,
              contextWindow: model.contextWindow ?? model.maxContextWindow ?? 128000,
              inputFormat: {
                supportsText: model.inputModalities?.includes("text") ?? true,
                supportsImage: model.inputModalities?.includes("image") ?? model.images ?? false,
                supportsVideo: model.inputModalities?.includes("video") ?? false,
                supportsAudio: model.inputModalities?.includes("audio") ?? false,
                supportsPdf: model.inputModalities?.includes("pdf") ?? false,
              },
              outputFormat: { supportsText: true },
              supportsToolCall: model.toolCall ?? true,
              supportsJsonSchemaOutput: false,
              supportsNativeWebSearch: false,
              supportsMidConversationSystem: true,
            },
            optionSpecs: createAuthModelOptionSpecs(model),
          }),
        });
    }
    const modelRules = new ModelConfigRules([...(snapshot.modelRules?.rules() ?? []), ...rules]);
    return {
      ...snapshot,
      providers: new ProviderConfigMap(providers.rules()),
      modelRules,
      revision: `${snapshot.revision}:oauth:${JSON.stringify([providers.toJSON(), rules.map((rule) => rule.config.toJSON())])}`,
    };
  }
  return {
    read: async () => project(await base.read()),
    refresh: async (reason: string) => project(await base.refresh(reason)),
    onDidChange(listener: (reason: string) => void) {
      const offBase = base.onDidChange(listener);
      const offAccounts = accounts.onDidChange(() => listener("oauth-accounts"));
      return () => {
        offBase();
        offAccounts.dispose();
      };
    },
  };
}
