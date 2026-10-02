import type { PluginDiagnostic, PluginStoreListing } from "@lcode/contracts";
import type { PluginComponentGroup } from "./plugin-components.js";
import type { AtomicDirectoryActivation } from "./atomic-directory.js";

export type MarketplaceSource =
  | { source: "url"; headers?: Record<string, string>; url: string }
  | { path?: string; ref?: string; repo: string; source: "github"; sparsePaths?: string[] }
  | { path?: string; ref?: string; source: "git"; sparsePaths?: string[]; url: string }
  | { package: string; source: "npm" }
  | { source: "file"; path: string }
  | { source: "directory"; path: string }
  | { hostPattern: string; source: "hostPattern" }
  | { pathPattern: string; source: "pathPattern" }
  | { source: "settings"; marketplace: PluginMarketplaceManifest };

export interface PluginMarketplaceEntry {
  name: string;
  category?: string;
  description?: string;
  version?: string;
  source?: unknown;
  // 内置 official 插件 seed 时写入的缓存目录绝对路径（source 为 "filesystem"/"sea"）。
  // describe/解析时据此直接定位已落盘的插件根目录，无需把 source 当路径解析。
  cachePath?: string;
  dependencies?: string[];
  strict?: boolean;
  tags?: string[];
  // 商店信息（displayName/icon/hero/示例提示词/链接等展示元数据），从条目 raw 解析；
  // 全部可选，见 contracts PluginStoreListing。
  listing?: PluginStoreListing;
  raw: Record<string, unknown>;
}

export interface PluginMarketplaceManifest {
  name: string;
  description?: string;
  plugins: PluginMarketplaceEntry[];
  allowCrossMarketplaceDependenciesOn?: string[];
  pluginRoot?: string;
  // 商店「公开」分段 Featured 区的策展名单（插件 name，按序）；由目录 JSON 顶层 featured 字段远程控制。
  featured?: string[];
  raw: Record<string, unknown>;
}

export interface KnownMarketplaceRecord {
  id: string;
  source: MarketplaceSource;
  name: string;
  description?: string;
  addedAt: string;
  lastUpdated?: string;
  lastRefreshFailure?: MarketplaceRefreshFailure;
  pluginCount: number;
  /** 内部崩溃恢复代际；协议/UI 投影不暴露。 */
  cacheTransactionId?: string;
}

export interface MarketplaceRefreshFailure {
  code: PluginDiagnostic["code"];
  failedAt: string;
  message: string;
}

export interface InstalledPluginRecord {
  id: string;
  name: string;
  marketplace: string;
  version: string;
  installPath: string;
  installedAt: string;
  updatedAt?: string;
  scope: "user" | "workspace";
  dependencies?: string[];
  source?: unknown;
  /** 内部崩溃恢复代际；协议/UI 投影不暴露。 */
  cacheTransactionId?: string;
}

export interface InstalledPluginsState {
  version: 1;
  plugins: InstalledPluginRecord[];
}

export interface MarketplaceInstallResult {
  closure: string[];
  installed: InstalledPluginRecord[];
}

export interface PluginValidationDiagnostic {
  code: PluginDiagnostic["code"];
  message: string;
  path?: string;
  pluginId?: string;
  severity: PluginDiagnostic["severity"];
}

export interface DescribeMarketplacePluginResult {
  components: PluginComponentGroup[];
  diagnostics: PluginValidationDiagnostic[];
  // 插件包内 plugin.json 的展示性回退字段（作者/主页/版本）；商店信息缺失时详情页信息区用它兜底。
  metadata?: PluginManifestDisplayMetadata;
}

export interface PluginManifestDisplayMetadata {
  author?: string;
  authorUrl?: string;
  homepage?: string;
  version?: string;
}

export interface KnownMarketplaceActivation {
  finalize: () => void;
  rollback: () => Promise<void>;
}

export interface LoadMarketplaceResult {
  cleanup?: () => Promise<void>;
  manifest: PluginMarketplaceManifest;
  sourceRoot?: string;
}

export interface ResolvedPluginSourceRoot {
  cleanup?: () => Promise<void>;
  path: string;
}

export interface CachedMarketplacePluginResult {
  activation?: AtomicDirectoryActivation;
  record: InstalledPluginRecord;
}
