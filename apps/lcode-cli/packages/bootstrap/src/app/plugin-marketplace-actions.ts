import { isDeepStrictEqual } from "node:util";
import {
  addMarketplace,
  describeMarketplacePlugin,
  ensureDefaultPluginMarketplaces,
  ensureMarketplaceManifestAvailable,
  loadKnownMarketplacesSync,
  parseMarketplaceSourceInput,
  removeMarketplace,
  updateMarketplace,
  validateLocalPluginPath,
  validateMarketplacePlugin,
  validateMarketplaceSource,
  type DescribeMarketplacePluginResult,
  type KnownMarketplaceRecord,
} from "@lcode/adapters/plugins";
import type { PluginLoadOutcome } from "@lcode/contracts";
import {
  type LCodeMarketplaceSummaryData,
  type LCodeMarketplaceUpdateData,
  type AddLCodeMarketplaceOptions,
  type RemoveLCodeMarketplaceOptions,
  type UpdateLCodeMarketplaceOptions,
  type ValidateLCodePluginPathOptions,
  type ValidateLCodePluginOptions,
  type DescribeLCodePluginOptions,
} from "./plugin-management-types.js";
import { resolvePluginContext } from "./plugin-management-context.js";
import { toMarketplaceSummaryData } from "./plugin-catalog-data.js";
import {
  resolveDeclaredMarketplaceSources,
  resolveMarketplaceRefreshTargetIds,
  applySparsePaths,
} from "./plugin-marketplace-sources.js";
import {
  createMarketplaceSourceRepointDiagnostic,
  toPluginDiagnostic,
  toMarketplaceRefreshDiagnostic,
} from "./plugin-marketplace-diagnostics.js";

export async function addLCodePluginMarketplace(
  options: AddLCodeMarketplaceOptions,
): Promise<LCodeMarketplaceSummaryData> {
  const { pluginStorageRoot } = resolvePluginContext(options);
  const source = applySparsePaths(
    await parseMarketplaceSourceInput(options.source),
    options.sparsePaths,
  );
  if (options.dryRun === true) {
    return {
      id: "dry-run",
      name: "dry-run",
      source: source as unknown as Record<string, unknown>,
      pluginCount: 0,
      isOfficial: false,
    };
  }
  const record = await addMarketplace({
    signal: options.abortSignal,
    source,
    storageRoot: pluginStorageRoot,
  });
  return toMarketplaceSummaryData(record);
}

export async function removeLCodePluginMarketplace(
  options: RemoveLCodeMarketplaceOptions,
): Promise<void> {
  const { pluginStorageRoot } = resolvePluginContext(options);
  await removeMarketplace({
    marketplace: options.marketplace,
    storageRoot: pluginStorageRoot,
  });
}

export async function updateLCodePluginMarketplace(
  options: UpdateLCodeMarketplaceOptions,
): Promise<LCodeMarketplaceUpdateData> {
  const { configResult, pluginStorageRoot } = resolvePluginContext(options);
  ensureDefaultPluginMarketplaces(pluginStorageRoot);
  const declared = resolveDeclaredMarketplaceSources({
    configResult,
  });
  const known = loadKnownMarketplacesSync(pluginStorageRoot);
  const knownById = new Map(known.map((record) => [record.id, record]));
  const targetIds = resolveMarketplaceRefreshTargetIds({
    declaredIds: declared.keys(),
    knownIds: knownById.keys(),
    marketplace: options.marketplace,
  });
  if (
    options.marketplace &&
    !knownById.has(options.marketplace) &&
    !declared.has(options.marketplace)
  ) {
    throw new Error(`Marketplace not found: ${options.marketplace}`);
  }

  const updated: KnownMarketplaceRecord[] = [];
  const declarationDiagnostics: PluginLoadOutcome["diagnostics"] = [];
  for (const marketplaceId of targetIds) {
    const declarationSource = declared.get(marketplaceId);
    const knownRecord = knownById.get(marketplaceId);
    if (
      options.marketplace &&
      declarationSource &&
      knownRecord &&
      !isDeepStrictEqual(knownRecord.source, declarationSource)
    ) {
      declarationDiagnostics.push(createMarketplaceSourceRepointDiagnostic(marketplaceId));
      continue;
    }
    if (declarationSource && !knownRecord) {
      try {
        updated.push(
          await addMarketplace({
            expectedId: marketplaceId,
            signal: options.abortSignal,
            source: declarationSource,
            storageRoot: pluginStorageRoot,
          }),
        );
      } catch (error) {
        declarationDiagnostics.push(toMarketplaceRefreshDiagnostic(error, marketplaceId));
      }
      continue;
    }
    updated.push(
      ...(await updateMarketplace({
        marketplace: marketplaceId,
        signal: options.abortSignal,
        storageRoot: pluginStorageRoot,
      })),
    );
  }

  // map 回调只吃第一个参数：toMarketplaceSummaryData 的第二参是 featured，不能接 map 的 index。
  const records = loadKnownMarketplacesSync(pluginStorageRoot);
  const selectedFailures = records.flatMap((record): PluginLoadOutcome["diagnostics"] => {
    if (options.marketplace && record.id !== options.marketplace) return [];
    if (!record.lastRefreshFailure) return [];
    return [
      {
        code: record.lastRefreshFailure.code,
        message: record.lastRefreshFailure.message,
        pluginId: record.id,
        severity: "error",
      },
    ];
  });
  return {
    marketplaces: updated.map((record) => toMarketplaceSummaryData(record)),
    diagnostics: [...declarationDiagnostics, ...selectedFailures],
  };
}

/** `lcode plugins validate <path>`：只读校验本地插件目录或 marketplace 目录。 */
export async function validateLCodePluginPath(
  options: ValidateLCodePluginPathOptions,
): Promise<PluginLoadOutcome["diagnostics"]> {
  const { pluginStorageRoot } = resolvePluginContext(options);
  return (
    await validateLocalPluginPath({
      path: options.path,
      signal: options.abortSignal,
      storageRoot: pluginStorageRoot,
    })
  ).map(toPluginDiagnostic);
}

export async function validateLCodePlugin(
  options: ValidateLCodePluginOptions,
): Promise<PluginLoadOutcome["diagnostics"]> {
  const { pluginStorageRoot } = resolvePluginContext(options);
  ensureDefaultPluginMarketplaces(pluginStorageRoot);
  if (options.source) {
    try {
      const source = await parseMarketplaceSourceInput(options.source);
      return (
        await validateMarketplaceSource({
          source,
          storageRoot: pluginStorageRoot,
        })
      ).map(toPluginDiagnostic);
    } catch (error) {
      return [
        {
          code: "plugin_marketplace_invalid",
          message: error instanceof Error ? error.message : String(error),
          severity: "error",
        },
      ];
    }
  }
  if (options.marketplace && options.pluginName) {
    try {
      await ensureMarketplaceManifestAvailable({
        marketplace: options.marketplace,
        storageRoot: pluginStorageRoot,
      });
    } catch (error) {
      return [
        {
          code: "plugin_marketplace_invalid",
          message: error instanceof Error ? error.message : String(error),
          pluginId: `${options.pluginName}@${options.marketplace}`,
          severity: "error",
        },
      ];
    }
    return (
      await validateMarketplacePlugin({
        marketplace: options.marketplace,
        name: options.pluginName,
        storageRoot: pluginStorageRoot,
      })
    ).map(toPluginDiagnostic);
  }
  return [];
}

export async function describeLCodePlugin(
  options: DescribeLCodePluginOptions,
): Promise<DescribeMarketplacePluginResult> {
  const { pluginStorageRoot } = resolvePluginContext(options);
  ensureDefaultPluginMarketplaces(pluginStorageRoot);
  return describeMarketplacePlugin({
    marketplace: options.marketplace,
    name: options.pluginName,
    storageRoot: pluginStorageRoot,
  });
}
