// Config Port Implementation - Scoped configuration with change notification

import {
  ConfigKey,
  type ConfigValue,
  type ConfigSource,
  type RuntimeConfig,
  type RuntimeConfigPatch,
  type ConfigObserver,
  type ConfigPort,
  ConfigScope,
  DefaultRuntimeConfig as DefaultConfig,
} from "@lcode/contracts";

import { ConfigStore, type AllHandler, type Handler } from "./config-store.js";

// ============================================================
// Config Port Implementation
// ============================================================

export class ConfigPortImpl implements ConfigPort {
  private store: ConfigStore;

  constructor(initial?: RuntimeConfigPatch) {
    this.store = new ConfigStore(initial ?? DefaultConfig);
  }

  get<K extends ConfigKey>(key: K): ConfigValue<K> {
    const value = this.store.get(key);
    if (value !== undefined) return value;

    // Fallback to default config
    const defaultValue = getDefaultValue(key) as ConfigValue<K> | undefined;
    if (defaultValue !== undefined) return defaultValue;

    throw new Error(`Config key not found: ${key}`);
  }

  getAll(): RuntimeConfig {
    return {
      modelStream: {
        idleTimeoutMs:
          this.store.get(ConfigKey.ModelStreamIdleTimeout) ??
          DefaultConfig.modelStream.idleTimeoutMs,
      },
      permission: {
        mode: this.get(ConfigKey.PermissionMode),
        allowedTools: this.get(ConfigKey.PermissionAllowedTools),
        disallowedTools: this.get(ConfigKey.PermissionDisallowedTools),
        autoApproveHighRisk: this.get(ConfigKey.PermissionAutoApproveHighRisk),
        allowMediumRiskInAuto: this.get(ConfigKey.PermissionAllowMediumRiskInAuto),
      },
      storage: {
        dir: this.store.get(ConfigKey.StorageDir) ?? DefaultConfig.storage.dir,
        sessionDbPath:
          this.store.get(ConfigKey.StorageSessionDbPath) ?? DefaultConfig.storage.sessionDbPath,
      },
      network: {
        httpProxy: this.store.get(ConfigKey.HttpProxy),
        noProxy: this.store.get(ConfigKey.NoProxy),
        caCertFile: this.store.get(ConfigKey.CaCertFile),
        timeout: this.store.get(ConfigKey.HttpTimeout) ?? DefaultConfig.network.timeout,
      },
      features: {
        compact: this.store.get(ConfigKey.FeatureCompact) ?? true,
        rewind: this.store.get(ConfigKey.FeatureRewind) ?? true,
        subagent: this.store.get(ConfigKey.FeatureSubagent) ?? true,
        memory: this.store.get(ConfigKey.FeatureMemory) ?? true,
        skill: this.store.get(ConfigKey.FeatureSkill) ?? true,
        mcp: this.store.get(ConfigKey.FeatureMcp) ?? true,
      },
      memory: {
        use: this.store.get(ConfigKey.MemoryUse) ?? DefaultConfig.memory.use,
      },
      sessionRecall: {
        enabled:
          this.store.get(ConfigKey.SessionRecallEnabled) ?? DefaultConfig.sessionRecall.enabled,
      },
      mcp: {
        servers: this.store.get(ConfigKey.McpServers) ?? DefaultConfig.mcp.servers,
      },
      plugins: {
        dirs: this.store.get(ConfigKey.PluginsDirs) ?? DefaultConfig.plugins.dirs,
        enabled: this.store.get(ConfigKey.PluginsEnabled) ?? DefaultConfig.plugins.enabled,
        enabledPlugins:
          this.store.get(ConfigKey.PluginsEnabledPlugins) ?? DefaultConfig.plugins.enabledPlugins,
        extraKnownMarketplaces:
          this.store.get(ConfigKey.PluginsExtraKnownMarketplaces) ??
          DefaultConfig.plugins.extraKnownMarketplaces,
        options: this.store.get(ConfigKey.PluginsOptions) ?? DefaultConfig.plugins.options,
        suppressedBuiltins:
          this.store.get(ConfigKey.PluginsSuppressedBuiltins) ??
          DefaultConfig.plugins.suppressedBuiltins,
      },
      skills: {
        enabled: this.store.get(ConfigKey.SkillsEnabled) ?? true,
        includeInstructions: this.store.get(ConfigKey.SkillsIncludeInstructions) ?? true,
        metadataBudget:
          this.store.get(ConfigKey.SkillsMetadataBudget) ?? DefaultConfig.skills.metadataBudget,
        roots: this.store.get(ConfigKey.SkillsRoots) ?? DefaultConfig.skills.roots,
      },
      skillOverrides: this.store.get(ConfigKey.SkillOverrides) ?? DefaultConfig.skillOverrides,
      commandOverrides:
        this.store.get(ConfigKey.CommandOverrides) ?? DefaultConfig.commandOverrides,
      logging: {
        level: this.store.get(ConfigKey.LogLevel) ?? "info",
        format: this.store.get(ConfigKey.LogFormat) ?? DefaultConfig.logging.format,
      },
      toolConcurrency: {
        maxConcurrency:
          this.store.get(ConfigKey.ToolConcurrencyMax) ??
          DefaultConfig.toolConcurrency.maxConcurrency,
      },
      modelAnomalyGuard:
        this.store.get(ConfigKey.ModelAnomalyGuard) ?? DefaultConfig.modelAnomalyGuard,
      hooks: this.store.get(ConfigKey.Hooks) ?? DefaultConfig.hooks,
      ui: {
        locale: this.store.get(ConfigKey.UiLocale) ?? DefaultConfig.ui.locale,
        theme: this.store.get(ConfigKey.UiTheme) ?? DefaultConfig.ui.theme,
      },
    };
  }

  has(key: ConfigKey): boolean {
    return this.store.has(key) || hasDefaultValue(key);
  }

  set<K extends ConfigKey>(key: K, value: ConfigValue<K>): void {
    // Runtime changes are always session scope
    this.store.set(key, value, ConfigScope.Session);
  }

  observe(): ConfigObserver {
    return {
      subscribe: <K extends ConfigKey>(key: K, handler: Handler<K>) =>
        this.store.subscribe(key, handler),
      subscribeAll: (handler: AllHandler) => this.store.subscribeAll(handler),
    };
  }

  getSources(key: ConfigKey): ConfigSource[] {
    return this.store.getSources(key);
  }

  merge(config: RuntimeConfigPatch, scope: ConfigScope): void {
    this.store.merge(config, scope);
  }
}

// ============================================================
// Helpers
// ============================================================

function getDefaultValue(key: ConfigKey): unknown {
  const defaults = DefaultConfig;
  switch (key) {
    case ConfigKey.ModelStreamIdleTimeout:
      return defaults.modelStream.idleTimeoutMs;
    case ConfigKey.PermissionMode:
      return defaults.permission.mode;
    case ConfigKey.PermissionAllowedTools:
      return defaults.permission.allowedTools;
    case ConfigKey.PermissionDisallowedTools:
      return defaults.permission.disallowedTools;
    case ConfigKey.PermissionAutoApproveHighRisk:
      return defaults.permission.autoApproveHighRisk;
    case ConfigKey.PermissionAllowMediumRiskInAuto:
      return defaults.permission.allowMediumRiskInAuto;
    case ConfigKey.StorageDir:
      return defaults.storage.dir;
    case ConfigKey.StorageSessionDbPath:
      return defaults.storage.sessionDbPath;
    case ConfigKey.HttpProxy:
      return defaults.network.httpProxy;
    case ConfigKey.NoProxy:
      return defaults.network.noProxy;
    case ConfigKey.CaCertFile:
      return defaults.network.caCertFile;
    case ConfigKey.HttpTimeout:
      return defaults.network.timeout;
    case ConfigKey.FeatureCompact:
      return defaults.features.compact;
    case ConfigKey.FeatureRewind:
      return defaults.features.rewind;
    case ConfigKey.FeatureSubagent:
      return defaults.features.subagent;
    case ConfigKey.FeatureMemory:
      return defaults.features.memory;
    case ConfigKey.FeatureSkill:
      return defaults.features.skill;
    case ConfigKey.FeatureMcp:
      return defaults.features.mcp;
    case ConfigKey.MemoryUse:
      return defaults.memory.use;
    case ConfigKey.SessionRecallEnabled:
      return defaults.sessionRecall.enabled;
    case ConfigKey.McpServers:
      return defaults.mcp.servers;
    case ConfigKey.PluginsEnabled:
      return defaults.plugins.enabled;
    case ConfigKey.PluginsDirs:
      return defaults.plugins.dirs;
    case ConfigKey.PluginsEnabledPlugins:
      return defaults.plugins.enabledPlugins;
    case ConfigKey.PluginsExtraKnownMarketplaces:
      return defaults.plugins.extraKnownMarketplaces;
    case ConfigKey.PluginsOptions:
      return defaults.plugins.options;
    case ConfigKey.PluginsSuppressedBuiltins:
      return defaults.plugins.suppressedBuiltins;
    case ConfigKey.SkillsEnabled:
      return defaults.skills.enabled;
    case ConfigKey.SkillsIncludeInstructions:
      return defaults.skills.includeInstructions;
    case ConfigKey.SkillsMetadataBudget:
      return defaults.skills.metadataBudget;
    case ConfigKey.SkillsRoots:
      return defaults.skills.roots;
    case ConfigKey.LogLevel:
      return defaults.logging.level;
    case ConfigKey.LogFormat:
      return defaults.logging.format;
    case ConfigKey.ToolConcurrencyMax:
      return defaults.toolConcurrency.maxConcurrency;
    case ConfigKey.ModelAnomalyGuard:
      return defaults.modelAnomalyGuard;
    case ConfigKey.Hooks:
      return defaults.hooks;
    case ConfigKey.UiLocale:
      return defaults.ui.locale;
    case ConfigKey.UiTheme:
      return defaults.ui.theme;
    default:
      return undefined;
  }
}

function hasDefaultValue(key: ConfigKey): boolean {
  return getDefaultValue(key) !== undefined;
}

// ============================================================
// Factory
// ============================================================

export function createConfigPort(initial?: RuntimeConfigPatch): ConfigPort {
  return new ConfigPortImpl(initial);
}

// Re-export adapters and factory
export {
  loadFileConfig,
  getDefaultConfigPath,
  hasDefaultConfigFile,
  resolvePath,
  updatePluginEnabledInFileConfig,
  enablePluginsByDefaultInFileConfig,
  removePluginEnabledFromFileConfig,
  updatePluginOptionsInFileConfig,
  removePluginFromFileConfig,
  addSuppressedBuiltinInFileConfig,
  removeSuppressedBuiltinInFileConfig,
  updateUiLocaleInFileConfig,
  type PluginEnabledPatchResult,
  type PluginOptionsPatchResult,
  type PluginRemovePatchResult,
  type SuppressedBuiltinPatchResult,
  type UiLocalePatchResult,
} from "./file-config.adapter.js";
export { parseEnvConfig, getToolConcurrencyConfig } from "./env-config.adapter.js";
export { LCodeConfigFileSchema, type LCodeConfigFile } from "./schema.js";
export { mergeConfigs, createPrioritizedConfig, getScopePriority } from "./config-merger.js";
export {
  createConfig,
  resolveWorkspaceStorageDir,
  type ConfigFactoryOptions,
  type ConfigResult,
} from "./config-factory.js";
