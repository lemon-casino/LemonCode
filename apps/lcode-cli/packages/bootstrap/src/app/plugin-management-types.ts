import { type ConfigResult } from "@lcode/adapters/config";
import type {
  Logger,
  PluginHookDetail,
  PluginLoadOutcome,
  PluginMetadata,
  PluginStoreListing,
} from "@lcode/contracts";

export interface ResolveLCodePluginsOptions {
  configResult?: ConfigResult;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  officialPluginRoots?: string[];
  pluginStorageRoot?: string;
  projectConfigPath?: string;
  skipUserConfig?: boolean;
  userConfigPath?: string;
  workingDirectory?: string;
}

export interface ListLCodePluginsOptions extends ResolveLCodePluginsOptions {}

export interface SetLCodePluginEnabledOptions extends ResolveLCodePluginsOptions {
  enabled: boolean;
  plugin: string;
  scope?: "user" | "workspace";
}

export interface SetLCodePluginEnabledResult {
  enabled: boolean;
  path: string;
  plugin: PluginMetadata;
}

export interface LCodeMarketplaceSummaryData {
  id: string;
  name: string;
  source: Record<string, unknown>;
  description?: string;
  lastUpdated?: string;
  pluginCount: number;
  isOfficial: boolean;
  refreshFailure?: {
    code: string;
    failedAt: string;
    message: string;
  };
  // 目录顶层 featured 策展名单（商店「公开」分段 Featured 区），随 manifest 下发。
  featured?: string[];
}

export interface LCodeAvailablePluginData {
  id: string;
  name: string;
  marketplace: string;
  description?: string;
  version?: string;
  installed: boolean;
  componentTypes?: string[];
  hookDetails?: PluginHookDetail[];
  // 商店信息（显示名/icon/分类/作者/链接/hero/示例提示词），来自目录条目。
  listing?: PluginStoreListing;
}

export interface LCodeInstalledPluginData {
  id: string;
  name: string;
  marketplace: string;
  description?: string;
  version?: string;
  enabled: boolean;
  scope: "user" | "workspace";
  installPath?: string;
  installedAt?: string;
  componentTypes?: string[];
  hookDetails?: PluginHookDetail[];
  updateStatus?: "none" | "update-available" | "version-changed";
  latestVersion?: string;
  // 已安装插件的商店信息由目录条目按 id join 得到（市场被移除时缺失，UI 走降级）。
  listing?: PluginStoreListing;
}

export interface LCodePluginsOverviewData {
  marketplaces: LCodeMarketplaceSummaryData[];
  availablePlugins: LCodeAvailablePluginData[];
  installedPlugins: LCodeInstalledPluginData[];
  restorableBuiltins: LCodeAvailablePluginData[];
  diagnostics: PluginLoadOutcome["diagnostics"];
}

export interface LCodeMarketplaceUpdateData {
  diagnostics: PluginLoadOutcome["diagnostics"];
  marketplaces: LCodeMarketplaceSummaryData[];
}

export interface AddLCodeMarketplaceOptions extends ResolveLCodePluginsOptions {
  abortSignal?: AbortSignal;
  dryRun?: boolean;
  source: string;
  /** `marketplace add --sparse`：仅 git/github 源支持 sparse checkout 子目录。 */
  sparsePaths?: string[];
}

export interface RemoveLCodeMarketplaceOptions extends ResolveLCodePluginsOptions {
  marketplace: string;
}

export interface UpdateLCodeMarketplaceOptions extends ResolveLCodePluginsOptions {
  abortSignal?: AbortSignal;
  marketplace?: string;
}

export interface InstallLCodeMarketplacePluginOptions extends ResolveLCodePluginsOptions {
  abortSignal?: AbortSignal;
  dryRun?: boolean;
  marketplace: string;
  pluginName: string;
  scope?: "user" | "workspace";
}

export interface UninstallLCodeMarketplacePluginOptions extends ResolveLCodePluginsOptions {
  pluginId?: string;
  pluginName?: string;
  marketplace?: string;
  removeCache?: boolean;
  /** 保留 data/<plugin-id> 用户数据目录（`lcode plugins uninstall --keep-data`）。 */
  keepData?: boolean;
}

export interface UpdateLCodeMarketplacePluginOptions extends ResolveLCodePluginsOptions {
  abortSignal?: AbortSignal;
  pluginId: string;
}

export interface ValidateLCodePluginPathOptions extends ResolveLCodePluginsOptions {
  abortSignal?: AbortSignal;
  path: string;
}

export interface LCodePluginUpdateData extends LCodePluginInstallData {
  previousVersion: string;
}

export interface RestoreBuiltinPluginOptions extends ResolveLCodePluginsOptions {
  pluginId: string;
}

export interface ConfigureLCodePluginOptions extends ResolveLCodePluginsOptions {
  clearOptionKeys?: string[];
  dryRun?: boolean;
  options: Record<string, unknown>;
  pluginId: string;
  scope?: "user" | "workspace";
}

export interface ResetLCodePluginConfigOptions extends ResolveLCodePluginsOptions {
  pluginId: string;
  scope?: "user" | "workspace";
}

export interface ValidateLCodePluginOptions extends ResolveLCodePluginsOptions {
  marketplace?: string;
  pluginName?: string;
  source?: string;
}

export interface DescribeLCodePluginOptions extends ResolveLCodePluginsOptions {
  marketplace: string;
  pluginName: string;
}

export interface LCodePluginInstallData {
  dependencyClosure: string[];
  installedPlugins: LCodeInstalledPluginData[];
  diagnostics: PluginLoadOutcome["diagnostics"];
}
