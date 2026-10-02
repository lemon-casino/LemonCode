import {
  comparePluginUpdate,
  ensureDefaultPluginMarketplaces,
  discoverNodePluginsSync,
  listInstalledPluginRecords,
  loadKnownMarketplacesSync,
  loadMarketplaceManifestSync,
  parseEntryStoreListing,
  readPluginSourceIdentityPin,
  type PluginMarketplaceEntry,
} from "@lcode/adapters/plugins";
import type { PluginLoadOutcome, PluginStoreListing } from "@lcode/contracts";
import { LCODE_OFFICIAL_PLUGIN_MARKETPLACE } from "@lcode/contracts";
import { resolveOfficialPluginRoots } from "./bundled-plugins.js";
import {
  DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS,
  OFFICIAL_NODE_REPL_HOST_PLUGIN_NAME,
  OFFICIAL_PLUGIN_DEFINITIONS,
} from "./official-plugin-definitions.js";
import {
  type ResolveLCodePluginsOptions,
  type ListLCodePluginsOptions,
  type LCodeMarketplaceSummaryData,
  type LCodeAvailablePluginData,
  type LCodePluginsOverviewData,
} from "./plugin-management-types.js";
import { resolvePluginContext } from "./plugin-management-context.js";
import {
  toMarketplaceSummaryData,
  toAvailablePluginData,
  toInstalledPluginData,
} from "./plugin-catalog-data.js";
import {
  resolveEffectiveMarketplaceRecords,
  resolveMarketplaceDeclarationDiagnostics,
} from "./plugin-marketplace-sources.js";

/**
 * 市场插件计数只数用户可见条目。
 *
 * node-repl-host 是 Browser Use 与 Computer Use 共用的运行时宿主：它必须留在官方 manifest 里
 * （否则不会被发现、安装、启用），但没有 skill、没有 listing，也不该出现在设置页。计进去会让
 * 显示的插件数比它能列出的条目多一个。
 *
 * 判据故意是「官方市场里的这个具名条目」，而不是「没有 listing 的条目」—— 后者会误伤第三方
 * 市场：自定义 manifest 里的条目本来就可以不带 listing，它们是真实可见的插件。
 */
function countVisibleMarketplacePlugins(
  marketplaceId: string,
  plugins: readonly { name: string }[] | undefined,
): number | undefined {
  if (!plugins) return undefined;
  if (marketplaceId !== LCODE_OFFICIAL_PLUGIN_MARKETPLACE) return plugins.length;
  return plugins.filter((entry) => entry.name !== OFFICIAL_NODE_REPL_HOST_PLUGIN_NAME).length;
}

export function resolveLCodePlugins(options: ResolveLCodePluginsOptions = {}): PluginLoadOutcome {
  const { configResult, pluginStorageRoot, workingDirectory } = resolvePluginContext(options);

  return discoverNodePluginsSync({
    config: configResult.config.plugins,
    env: options.env ?? process.env,
    officialPluginRoots: resolveOfficialPluginRoots({
      extraRoots: options.officialPluginRoots,
      // cache 锁冲突已从 fatal 改为 degraded，普通插件入口也必须保留诊断日志。
      logger: options.logger,
      storageRoot: pluginStorageRoot,
      suppressedBuiltins: new Set(configResult.config.plugins.suppressedBuiltins),
    }),
    officialPluginsEnabledByDefault: DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS,
    storageRoot: pluginStorageRoot,
    workingDirectory,
  });
}

export function getLCodePluginsOverview(
  options: ResolveLCodePluginsOptions = {},
): LCodePluginsOverviewData {
  const { configResult, pluginStorageRoot, workingDirectory } = resolvePluginContext(options);
  ensureDefaultPluginMarketplaces(pluginStorageRoot);
  const outcome = resolveLCodePlugins({
    ...options,
    configResult,
    pluginStorageRoot,
  });
  const known = loadKnownMarketplacesSync(pluginStorageRoot);
  const effectiveMarketplaces = resolveEffectiveMarketplaceRecords({
    configResult,
    known,
    workingDirectory,
  });
  const marketplaceDeclarationDiagnostics = resolveMarketplaceDeclarationDiagnostics({
    configResult,
    known,
    workingDirectory,
  });
  const installed = listInstalledPluginRecords(pluginStorageRoot);
  const installedIds = new Set(installed.map((record) => record.id));

  // 每个市场的 manifest 只读一次：同时取 entries（目录条目）与 featured（策展名单）。
  // zcode-plugins-official 的内置与 CDN 分片已在 adapter 层合并为唯一 canonical manifest。
  const catalogs: Array<{
    summary: LCodeMarketplaceSummaryData;
    entries: PluginMarketplaceEntry[];
  }> = [];
  for (const { record, useCachedManifest } of effectiveMarketplaces) {
    // Marketplace source 只来自 User/Host 配置。只有目标 Host 已经通过显式 refresh/install
    // 物化了同一 source 时，才读取 Host cache；同 id 不同 source 必须 fail closed，避免
    // 不同 Host 或旧配置误用错误的全局 marketplace 快照。
    const manifest = useCachedManifest
      ? loadMarketplaceManifestSync(pluginStorageRoot, record.id)
      : null;
    catalogs.push({
      summary: toMarketplaceSummaryData(
        record,
        manifest?.featured,
        countVisibleMarketplacePlugins(record.id, manifest?.plugins),
      ),
      entries: manifest?.plugins ?? [],
    });
  }

  // 边遍历 marketplace catalog 边记录每个插件 id 的最新「版本 pin」用于更新检测。

  // 条目可能只有 version、只有 sha 或两者兼有，因此同时收集 version 与 sha
  // 两个轴，由 comparePluginUpdate 决定用哪条轴比对 installed 记录。
  const latestPinByPluginId = new Map<string, { version?: string; sha?: string }>();
  // 同时按 id 收集目录条目的商店信息，供已安装插件 join（详情/图标条/管理视图共用）。
  const listingByPluginId = new Map<string, PluginStoreListing>();
  const availablePlugins = catalogs.flatMap((catalog) =>
    catalog.entries.map((entry) => {
      const data = toAvailablePluginData(entry, catalog.summary.id, installedIds);
      latestPinByPluginId.set(data.id, {
        ...(entry.version ? { version: entry.version } : {}),
        ...(readPluginSourceIdentityPin(entry.source)
          ? { sha: readPluginSourceIdentityPin(entry.source) }
          : {}),
      });
      if (entry.listing) listingByPluginId.set(data.id, entry.listing);
      return data;
    }),
  );
  const loadedById = new Map(outcome.plugins.map((plugin) => [plugin.id, plugin]));

  // 被抑制（uninstall）的内置（官方）插件可一键恢复：从 OFFICIAL_PLUGIN_DEFINITIONS
  // 里挑出 id 落在 suppressedBuiltins 集合内的，映射成 available 形态供 UI 的「恢复」入口使用。
  // 完整 Catalog/cache 仍然保留，restorable 只是 Runtime 抑制态的投影，商店信息直接取定义里的 listing seed。
  const suppressed = new Set(configResult.config.plugins.suppressedBuiltins);
  // 恢复入口只反映 suppression；internal gate 是开发 bypass，不能让正式插件从恢复面消失。
  const restorableBuiltins: LCodeAvailablePluginData[] = OFFICIAL_PLUGIN_DEFINITIONS.filter((def) =>
    suppressed.has(`${def.name}@${LCODE_OFFICIAL_PLUGIN_MARKETPLACE}`),
  ).map((def) => {
    const listing = def.listing
      ? parseEntryStoreListing({ name: def.name, ...def.listing })
      : undefined;
    return {
      id: `${def.name}@${LCODE_OFFICIAL_PLUGIN_MARKETPLACE}`,
      name: def.name,
      marketplace: LCODE_OFFICIAL_PLUGIN_MARKETPLACE,
      version: def.version,
      installed: false,
      ...(listing ? { listing } : {}),
    };
  });

  return {
    marketplaces: catalogs.map((catalog) => catalog.summary),
    availablePlugins,
    installedPlugins: installed.map((record) => {
      const enabled = configResult.config.plugins.enabledPlugins[record.id] ?? false;
      const data = toInstalledPluginData(record, enabled, loadedById.get(record.id));
      const pin = latestPinByPluginId.get(record.id);
      const installedSha = readPluginSourceIdentityPin(record.source);
      const updateStatus = comparePluginUpdate({
        installedVersion: data.version,
        installedSha,
        latestVersion: pin?.version,
        latestSha: pin?.sha,
      });
      // latestVersion 展示：优先用 manifest 的 version；否则用最新 sha（短 7 位）让 UI 有可读提示。
      const latestLabel = pin?.version ?? (pin?.sha ? pin.sha.slice(0, 7) : undefined);
      const listing = listingByPluginId.get(record.id);
      return {
        ...data,
        updateStatus,
        ...(latestLabel ? { latestVersion: latestLabel } : {}),
        ...(listing ? { listing } : {}),
      };
    }),
    restorableBuiltins,
    diagnostics: [
      ...outcome.diagnostics,
      ...marketplaceDeclarationDiagnostics,
      ...known.flatMap((record): PluginLoadOutcome["diagnostics"] =>
        record.lastRefreshFailure
          ? [
              {
                code: record.lastRefreshFailure.code,
                message: record.lastRefreshFailure.message,
                pluginId: record.id,
                severity: "error",
              },
            ]
          : [],
      ),
    ],
  };
}

export function listLCodePlugins(options: ListLCodePluginsOptions = {}): PluginLoadOutcome {
  const outcome = resolveLCodePlugins(options);
  const { pluginStorageRoot } = resolvePluginContext(options);
  return {
    ...outcome,
    // 用户可见名称必须从 marketplace listing 解析；这里按完整 id 传递给 CLI，
    // 不把展示元数据混入 adapter 的运行时 PluginMetadata，也不按裸 name 猜测。
    pluginListingsById: loadPluginListingsById(pluginStorageRoot),
  };
}

function loadPluginListingsById(storageRoot: string): Record<string, PluginStoreListing> {
  const listings = new Map<string, PluginStoreListing>();

  // 没有 marketplace 快照时，bundled official definition 仍是内置插件 listing 的安全回退。
  for (const definition of OFFICIAL_PLUGIN_DEFINITIONS) {
    if (!definition.listing) continue;
    const listing = parseEntryStoreListing({ name: definition.name, ...definition.listing });
    if (listing) {
      listings.set(`${definition.name}@${LCODE_OFFICIAL_PLUGIN_MARKETPLACE}`, listing);
    }
  }

  // 目录条目按完整 `${name}@${marketplace}` 关联；同名插件不会互相覆盖。
  for (const marketplace of loadKnownMarketplacesSync(storageRoot)) {
    const manifest = loadMarketplaceManifestSync(storageRoot, marketplace.id);
    for (const entry of manifest?.plugins ?? []) {
      if (entry.listing) listings.set(`${entry.name}@${marketplace.id}`, entry.listing);
    }
  }

  return Object.fromEntries(listings);
}
