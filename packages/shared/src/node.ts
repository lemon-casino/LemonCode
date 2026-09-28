/**
 * Node-only shared utilities.
 *
 * This subpath must not be imported by renderer/browser bundles.
 */
export { acquireFileLock } from "./node/atomicFileLock.js";
export {
  migrateDirCopyStyle,
  migrateDirCopyStyleSync,
  migrateHomeBrandDataRootSync,
  migrateWorkspaceBrandDirsSync,
  migrateHomeBrandDataRoot,
  migrateWorkspaceBrandDirs,
  HOME_DATA_DIR,
  LEGACY_HOME_DATA_DIR,
  WORKSPACE_PLUGIN_DIR,
  LEGACY_WORKSPACE_PLUGIN_DIR,
  type BrandDataMigrationSummary,
  type BrandDirMigrationOutcome,
  type BrandDirMigrationStatus,
} from "./node/brandDataMigration.js";
export { scanOfficialPluginCacheRoots } from "./node/officialPluginCache.js";
export {
  migrateUserSubagentMarkdown,
  migrateSubagentStateFile,
} from "./node/subagentMarkdownMigration.js";
export {
  atomicWritePrivateTextFile,
  backupCorruptFile,
  withFileLock,
  type SharedFileLockOptions,
} from "./node/privateFilePersistence.js";
export {
  createNodeSelfResourceSampler,
  NODE_SELF_RESOURCE_SAMPLE_INTERVAL_MS,
  type NodeSelfResourceSampler,
  type NodeSelfResourceSamplerOptions,
} from "./node/nodeSelfResourceTelemetry.js";
