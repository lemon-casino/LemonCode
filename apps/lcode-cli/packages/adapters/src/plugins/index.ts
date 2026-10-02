export {
  NodePluginAdapter,
  createNodePluginAdapter,
  discoverNodePluginsSync,
  type NodePluginAdapterOptions,
} from "./plugin-discovery.js";
export {
  addMarketplace,
  describeMarketplacePlugin,
  ensureDefaultPluginMarketplaces,
  ensureMarketplaceManifestAvailable,
  getPluginDataDir,
  installMarketplacePlugin,
  listInstalledPluginRecords,
  loadKnownMarketplacesSync,
  loadMarketplaceManifestSync,
  normalizeAuthorValue,
  parseEntryStoreListing,
  parseMarketplaceSourceInput,
  readPluginSourceIdentityPin,
  readPluginSourceSha,
  removeMarketplace,
  uninstallMarketplacePlugin,
  updateMarketplace,
  validateMarketplacePlugin,
  validateLocalPluginPath,
  validateMarketplaceSource,
  type DescribeMarketplacePluginResult,
  type InstalledPluginRecord,
  type KnownMarketplaceRecord,
  type MarketplaceSource,
  type PluginComponentGroup,
  type PluginComponentItem,
  type PluginComponentKind,
  type PluginManifestDisplayMetadata,
  type PluginMarketplaceEntry,
  type PluginMarketplaceManifest,
} from "./marketplace.js";
export {
  writeBundledOfficialMarketplacePartitionSync,
  writeCdnOfficialMarketplacePartitionSync,
} from "./official-marketplace.js";
export { getPluginSourceDiagnosticCode } from "./source-errors.js";
export {
  comparePluginUpdate,
  comparePluginVersions,
  type PluginUpdateStatus,
} from "./version-compare.js";
