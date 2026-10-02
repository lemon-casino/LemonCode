import {
  ConfigKey,
  ConfigScope,
  DefaultRuntimeConfig as DefaultConfig,
  type ConfigSource,
  type ConfigValue,
  type RuntimeConfigPatch,
  type Unsubscribe,
} from "@lcode/contracts";

export type Handler<K extends ConfigKey> = (value: ConfigValue<K>, prev: ConfigValue<K>) => void;
export type AllHandler = (key: ConfigKey, value: unknown, prev: unknown) => void;

// ============================================================
// Config Store - Internal state
// ============================================================

interface ConfigEntry {
  value: unknown;
  sources: ConfigSource[];
}

export class ConfigStore {
  private store = new Map<ConfigKey, ConfigEntry>();
  private observers: Map<ConfigKey, Set<Handler<any>>> = new Map();
  private allHandlers: Set<AllHandler> = new Set();

  constructor(initial?: RuntimeConfigPatch) {
    if (initial) {
      this.merge(initial, ConfigScope.System);
    }
  }

  get<K extends ConfigKey>(key: K): ConfigValue<K> | undefined {
    const entry = this.store.get(key);
    return entry?.value as ConfigValue<K>;
  }

  has(key: ConfigKey): boolean {
    return this.store.has(key);
  }

  set<K extends ConfigKey>(
    key: K,
    value: ConfigValue<K>,
    scope: ConfigScope,
    source?: string,
  ): void {
    const prev = this.get(key);
    const entry: ConfigEntry = {
      value,
      sources: [{ scope, key, value, path: source }],
    };
    this.store.set(key, entry);

    // Notify observers
    const handlers = this.observers.get(key);
    if (handlers) {
      handlers.forEach((handler) => handler(value, prev as ConfigValue<K>));
    }

    // Notify all-handlers
    this.allHandlers.forEach((handler) => handler(key, value, prev));
  }

  getSources(key: ConfigKey): ConfigSource[] {
    const entry = this.store.get(key);
    return entry?.sources ?? [];
  }

  merge(config: RuntimeConfigPatch, scope: ConfigScope): void {
    if (config.modelStream?.idleTimeoutMs !== undefined) {
      this.set(ConfigKey.ModelStreamIdleTimeout, config.modelStream.idleTimeoutMs, scope);
    }
    if (config.permission) {
      if (config.permission.mode) this.set(ConfigKey.PermissionMode, config.permission.mode, scope);
      if (config.permission.allowedTools)
        this.set(ConfigKey.PermissionAllowedTools, config.permission.allowedTools, scope);
      if (config.permission.disallowedTools)
        this.set(ConfigKey.PermissionDisallowedTools, config.permission.disallowedTools, scope);
      if (config.permission.autoApproveHighRisk !== undefined) {
        this.set(
          ConfigKey.PermissionAutoApproveHighRisk,
          config.permission.autoApproveHighRisk,
          scope,
        );
      }
      if (config.permission.allowMediumRiskInAuto !== undefined) {
        this.set(
          ConfigKey.PermissionAllowMediumRiskInAuto,
          config.permission.allowMediumRiskInAuto,
          scope,
        );
      }
    }
    if (config.storage) {
      if (config.storage.dir) this.set(ConfigKey.StorageDir, config.storage.dir, scope);
      if (config.storage.sessionDbPath)
        this.set(ConfigKey.StorageSessionDbPath, config.storage.sessionDbPath, scope);
    }
    if (config.network) {
      if (config.network.httpProxy !== undefined)
        this.set(ConfigKey.HttpProxy, config.network.httpProxy, scope);
      if (config.network.noProxy !== undefined)
        this.set(ConfigKey.NoProxy, config.network.noProxy, scope);
      if (config.network.caCertFile !== undefined)
        this.set(ConfigKey.CaCertFile, config.network.caCertFile, scope);
      if (config.network.timeout !== undefined)
        this.set(ConfigKey.HttpTimeout, config.network.timeout, scope);
    }
    if (config.features) {
      if (config.features.compact !== undefined)
        this.set(ConfigKey.FeatureCompact, config.features.compact, scope);
      if (config.features.rewind !== undefined)
        this.set(ConfigKey.FeatureRewind, config.features.rewind, scope);
      if (config.features.subagent !== undefined)
        this.set(ConfigKey.FeatureSubagent, config.features.subagent, scope);
      if (config.features.memory !== undefined)
        this.set(ConfigKey.FeatureMemory, config.features.memory, scope);
      if (config.features.skill !== undefined)
        this.set(ConfigKey.FeatureSkill, config.features.skill, scope);
      if (config.features.mcp !== undefined)
        this.set(ConfigKey.FeatureMcp, config.features.mcp, scope);
    }
    if (config.memory) {
      if (config.memory.use !== undefined) this.set(ConfigKey.MemoryUse, config.memory.use, scope);
    }
    if (config.sessionRecall?.enabled !== undefined) {
      this.set(ConfigKey.SessionRecallEnabled, config.sessionRecall.enabled, scope);
    }
    if (config.mcp) {
      if (config.mcp.servers !== undefined)
        this.set(ConfigKey.McpServers, config.mcp.servers, scope);
    }
    if (config.plugins) {
      if (config.plugins.enabled !== undefined)
        this.set(ConfigKey.PluginsEnabled, config.plugins.enabled, scope);
      if (config.plugins.dirs !== undefined)
        this.set(ConfigKey.PluginsDirs, config.plugins.dirs, scope);
      if (config.plugins.enabledPlugins !== undefined) {
        this.set(ConfigKey.PluginsEnabledPlugins, config.plugins.enabledPlugins, scope);
      }
      if (config.plugins.extraKnownMarketplaces !== undefined) {
        this.set(
          ConfigKey.PluginsExtraKnownMarketplaces,
          config.plugins.extraKnownMarketplaces,
          scope,
        );
      }
      if (config.plugins.options !== undefined) {
        this.set(ConfigKey.PluginsOptions, config.plugins.options, scope);
      }
      if (config.plugins.suppressedBuiltins !== undefined) {
        this.set(ConfigKey.PluginsSuppressedBuiltins, config.plugins.suppressedBuiltins, scope);
      }
    }
    if (config.skills) {
      if (config.skills.enabled !== undefined)
        this.set(ConfigKey.SkillsEnabled, config.skills.enabled, scope);
      if (config.skills.includeInstructions !== undefined) {
        this.set(ConfigKey.SkillsIncludeInstructions, config.skills.includeInstructions, scope);
      }
      if (config.skills.metadataBudget !== undefined) {
        this.set(ConfigKey.SkillsMetadataBudget, config.skills.metadataBudget, scope);
      }
      if (config.skills.roots !== undefined)
        this.set(ConfigKey.SkillsRoots, config.skills.roots, scope);
    }
    if (config.skillOverrides !== undefined) {
      this.set(ConfigKey.SkillOverrides, config.skillOverrides, scope);
    }
    if (config.commandOverrides !== undefined) {
      this.set(ConfigKey.CommandOverrides, config.commandOverrides, scope);
    }
    if (config.logging) {
      if (config.logging.level) this.set(ConfigKey.LogLevel, config.logging.level, scope);
      if (config.logging.format !== undefined)
        this.set(ConfigKey.LogFormat, config.logging.format, scope);
    }
    if (config.toolConcurrency) {
      if (config.toolConcurrency.maxConcurrency !== undefined)
        this.set(ConfigKey.ToolConcurrencyMax, config.toolConcurrency.maxConcurrency, scope);
    }
    if (config.modelAnomalyGuard) {
      const previous = this.get(ConfigKey.ModelAnomalyGuard) ?? DefaultConfig.modelAnomalyGuard;
      this.set(
        ConfigKey.ModelAnomalyGuard,
        {
          ...previous,
          ...config.modelAnomalyGuard,
        },
        scope,
      );
    }
    if (config.hooks) {
      const previous = this.get(ConfigKey.Hooks) ?? DefaultConfig.hooks;
      this.set(
        ConfigKey.Hooks,
        {
          ...previous,
          ...config.hooks,
          events: config.hooks.events ?? previous.events,
        },
        scope,
      );
    }
    if (config.ui?.locale !== undefined) {
      this.set(ConfigKey.UiLocale, config.ui.locale, scope);
    }
    if (config.ui?.theme !== undefined) {
      this.set(ConfigKey.UiTheme, config.ui.theme, scope);
    }
  }

  subscribe<K extends ConfigKey>(key: K, handler: Handler<K>): Unsubscribe {
    if (!this.observers.has(key)) {
      this.observers.set(key, new Set());
    }
    this.observers.get(key)!.add(handler);

    return () => {
      this.observers.get(key)?.delete(handler);
    };
  }

  subscribeAll(handler: AllHandler): Unsubscribe {
    this.allHandlers.add(handler);
    return () => {
      this.allHandlers.delete(handler);
    };
  }
}
