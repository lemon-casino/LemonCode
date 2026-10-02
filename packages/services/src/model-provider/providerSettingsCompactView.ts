import {
  isApiKeyAccess,
  type ProviderApiKey,
  type ProviderConfigObject,
  type ProviderSettingsView,
} from "@lcode/provider";

const summaries = new WeakMap<readonly ProviderApiKey[], { total: number; enabled: number }>();
const INLINE_KEY_LIMIT = 250;

function compactConfig(config: ProviderConfigObject): ProviderConfigObject {
  if (
    !isApiKeyAccess(config.access) ||
    !config.access.apiKeys ||
    config.access.apiKeys.length <= INLINE_KEY_LIMIT
  )
    return config;
  const { apiKeys: _keys, ...access } = config.access;
  return { ...config, access };
}

/** RPC 的日常配置通知不重复传输凭据池；完整内容只用于 Key 管理。 */
export function compactProviderSettingsView(view: ProviderSettingsView): ProviderSettingsView {
  return {
    ...view,
    providerTemplates: view.providerTemplates.map((template) => ({
      ...template,
      config: compactConfig(template.config),
    })),
    providers: view.providers.map((provider) => {
      const access = provider.effectiveConfig.access;
      const keys = isApiKeyAccess(access) ? access.apiKeys : undefined;
      const omitted = [
        provider.effectiveConfig,
        provider.personalConfig,
        provider.effectiveBuiltinConfig,
      ].some(
        (config) =>
          config &&
          isApiKeyAccess(config.access) &&
          (config.access.apiKeys?.length ?? 0) > INLINE_KEY_LIMIT,
      );
      if (!omitted) return provider;
      let summary = keys ? summaries.get(keys) : undefined;
      if (keys && !summary) {
        summary = {
          total: keys.length,
          enabled: keys.reduce((count, key) => count + Number(key.enabled !== false), 0),
        };
        summaries.set(keys, summary);
      }
      return {
        ...provider,
        apiKeysOmitted: true as const,
        ...(summary ? { apiKeySummary: summary } : {}),
        effectiveConfig: compactConfig(provider.effectiveConfig),
        ...(provider.personalConfig
          ? { personalConfig: compactConfig(provider.personalConfig) }
          : {}),
        ...(provider.effectiveBuiltinConfig
          ? { effectiveBuiltinConfig: compactConfig(provider.effectiveBuiltinConfig) }
          : {}),
      };
    }),
  };
}
