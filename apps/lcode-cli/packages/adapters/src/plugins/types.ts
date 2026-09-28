import type {
  CustomCommandRoot,
  HookEventName,
  HookMatcherConfig,
  McpServerConfig,
  PluginHookDetail,
  PluginManifest,
  PluginSource,
  SkillRoot,
} from "@lcode/contracts";

export interface PluginCandidate {
  defaultEnabled: boolean;
  marketplace: string;
  rootPath: string;
  source: PluginSource;
}

export interface LoadedPlugin {
  id: string;
  manifest: PluginManifest;
  manifestPath: string;
  marketplace: string;
  rootPath: string;
  source: PluginSource;
}

export interface PluginComponents {
  commandRoots: CustomCommandRoot[];
  hooks: Partial<Record<HookEventName, HookMatcherConfig[]>>;
  hookDetails: PluginHookDetail[];
  mcpServers: Record<string, McpServerConfig>;
  skillCount: number;
  skillRoots: SkillRoot[];
}

export interface PluginAbortOptions {
  signal?: AbortSignal;
}
