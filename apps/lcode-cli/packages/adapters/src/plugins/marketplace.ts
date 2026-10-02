// 保留既有入口；目录、安装事务和源解析各自只有一条实现路径。
export type {
  MarketplaceSource,
  PluginMarketplaceEntry,
  PluginMarketplaceManifest,
  KnownMarketplaceRecord,
  MarketplaceRefreshFailure,
  InstalledPluginRecord,
  PluginValidationDiagnostic,
  DescribeMarketplacePluginResult,
  PluginManifestDisplayMetadata,
} from "./marketplace-types.js";
export type {
  PluginComponentGroup,
  PluginComponentItem,
  PluginComponentKind,
} from "./plugin-components.js";
export { parseMarketplaceSourceInput } from "./marketplace-source-input.js";
export {
  ensureDefaultPluginMarketplaces,
  loadKnownMarketplacesSync,
  loadMarketplaceManifestSync,
} from "./marketplace-storage.js";
export {
  addMarketplace,
  ensureMarketplaceManifestAvailable,
  removeMarketplace,
  updateMarketplace,
} from "./marketplace-management.js";
export {
  listInstalledPluginRecords,
  resolveInstalledPluginRoot,
} from "./marketplace-installed-storage.js";
export { installMarketplacePlugin, uninstallMarketplacePlugin } from "./marketplace-install.js";
export {
  validateLocalPluginPath,
  validateMarketplacePlugin,
  validateMarketplaceSource,
} from "./marketplace-validation.js";
export { describeMarketplacePlugin } from "./marketplace-describe.js";
export { normalizeAuthorValue, parseEntryStoreListing } from "./marketplace-manifest.js";
export { readPluginSourceIdentityPin, readPluginSourceSha } from "./marketplace-plugin-source.js";
export { getPluginDataDir } from "./marketplace-files.js";
