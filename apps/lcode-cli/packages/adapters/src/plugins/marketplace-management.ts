import { isOfficialMarketplaceId, LCODE_OFFICIAL_PLUGIN_MARKETPLACE } from "@lcode/contracts";
import { appendPluginSourceCleanupError, cleanupPluginSourceBestEffort } from "./helpers.js";
import type { AtomicDirectoryActivation } from "./atomic-directory.js";
import { throwIfPluginOperationAborted } from "./marketplace-files.js";
import {
  ensureDefaultPluginMarketplaces,
  loadKnownMarketplacesSync,
  loadMarketplaceManifestSync,
  persistMarketplaceRefreshFailure,
  stageMarketplaceDirectoryPlugins,
  stageMarketplaceManifest,
  upsertKnownMarketplace,
  writeKnownMarketplaces,
} from "./marketplace-storage.js";
import { parseRequiredMarketplaceManifest } from "./marketplace-manifest.js";
import { loadMarketplaceFromSource } from "./marketplace-source.js";
import { toValidationDiagnostic } from "./marketplace-errors.js";
import { writeCdnOfficialMarketplacePartitionSync } from "./official-marketplace.js";
import type {
  KnownMarketplaceActivation,
  KnownMarketplaceRecord,
  LoadMarketplaceResult,
  MarketplaceSource,
} from "./marketplace-types.js";

export async function ensureMarketplaceManifestAvailable(input: {
  marketplace: string;
  signal?: AbortSignal;
  storageRoot: string;
}): Promise<KnownMarketplaceRecord | null> {
  throwIfPluginOperationAborted(input.signal);
  ensureDefaultPluginMarketplaces(input.storageRoot);
  if (loadMarketplaceManifestSync(input.storageRoot, input.marketplace)) {
    return (
      loadKnownMarketplacesSync(input.storageRoot).find(
        (record) => record.id === input.marketplace,
      ) ?? null
    );
  }
  const record = loadKnownMarketplacesSync(input.storageRoot).find(
    (item) => item.id === input.marketplace,
  );
  if (!record) return null;
  // 受信任的内部懒加载：用 known record 的规范 source 拉取，并以 record.id 作为 trustedId，
  // 使官方 id 只能由本来就是该官方 id 的记录刷新得到。
  return await addMarketplace({
    signal: input.signal,
    source: record.source,
    storageRoot: input.storageRoot,
    trustedId: record.id,
  });
}

export async function addMarketplace(input: {
  expectedId?: string;
  signal?: AbortSignal;
  source: MarketplaceSource;
  storageRoot: string;
  // 受信任的内部刷新传入正在刷新的 known record 规范 id。守卫只在 manifest 声明了官方 id
  // 且该 id 不等于本次刷新的 trustedId 时拒绝，避免来源在刷新过程中被改名冒用：
  //   - 用户侧新增（trustedId 缺失）声明官方 id → 拒绝；
  //   - 非官方市场日后把 manifest 改名成官方 id，刷新时 trustedId 不匹配 → 拒绝；
  // 非官方 manifest 名不受此约束，保持既有行为。
  trustedId?: string;
}): Promise<KnownMarketplaceRecord> {
  // persist:false 先只解析 manifest，不落盘——否则 marketplace 目录激活会用
  // 不可信 manifest.name 作为 target，先 rm 掉本地官方目录再 cp，等守卫抛错时
  // 官方 manifest 已被污染；守卫通过后才持久化。
  throwIfPluginOperationAborted(input.signal);
  const operationSignal = input.signal;
  let loaded: LoadMarketplaceResult | undefined;
  let knownMarketplaceActivation: KnownMarketplaceActivation | undefined;
  let marketplaceActivation: AtomicDirectoryActivation | undefined;
  try {
    loaded = await loadMarketplaceFromSource(input.source, input.storageRoot, {
      persist: false,
      signal: operationSignal,
    });
    throwIfPluginOperationAborted(operationSignal);
    if (isOfficialMarketplaceId(loaded.manifest.name) && loaded.manifest.name !== input.trustedId) {
      throw new Error(
        `Cannot add a marketplace named "${loaded.manifest.name}": that id is reserved for the official marketplace.`,
      );
    }
    if (input.expectedId && loaded.manifest.name !== input.expectedId) {
      throw new Error(
        `Marketplace declaration id mismatch: expected ${input.expectedId}, received ${loaded.manifest.name}`,
      );
    }
    if (
      input.trustedId === LCODE_OFFICIAL_PLUGIN_MARKETPLACE &&
      loaded.manifest.name !== LCODE_OFFICIAL_PLUGIN_MARKETPLACE
    ) {
      throw new Error(
        `Official marketplace source must provide ${LCODE_OFFICIAL_PLUGIN_MARKETPLACE}, received ${loaded.manifest.name}`,
      );
    }
    const persistedManifest =
      loaded.manifest.name === LCODE_OFFICIAL_PLUGIN_MARKETPLACE
        ? parseRequiredMarketplaceManifest(
            writeCdnOfficialMarketplacePartitionSync({
              manifest: loaded.manifest.raw,
              storageRoot: input.storageRoot,
            }),
          )
        : loaded.manifest;
    // 旧流程先删 marketplace target 再复制 source，刷新失败会丢失最后成功快照。
    // source tree 与规范 manifest 在同一 staging 目录准备完毕后一次 rename 激活。
    if (loaded.sourceRoot) {
      marketplaceActivation = await stageMarketplaceDirectoryPlugins(
        loaded.sourceRoot,
        input.storageRoot,
        loaded.manifest.name,
        persistedManifest.raw,
        operationSignal,
      );
    } else if (loaded.manifest.name !== LCODE_OFFICIAL_PLUGIN_MARKETPLACE) {
      marketplaceActivation = await stageMarketplaceManifest(
        input.storageRoot,
        loaded.manifest.name,
        loaded.manifest.raw,
        operationSignal,
      );
    }
    throwIfPluginOperationAborted(operationSignal);
    const now = new Date().toISOString();
    const record: KnownMarketplaceRecord = {
      id: loaded.manifest.name,
      source: input.source,
      name: loaded.manifest.name,
      ...(loaded.manifest.description ? { description: loaded.manifest.description } : {}),
      addedAt: now,
      lastUpdated: now,
      pluginCount: persistedManifest.plugins.length,
      ...(marketplaceActivation ? { cacheTransactionId: marketplaceActivation.transactionId } : {}),
    };
    knownMarketplaceActivation = await upsertKnownMarketplace(input.storageRoot, record);
    if (marketplaceActivation) {
      throwIfPluginOperationAborted(operationSignal);
    }
    // authority state 已落盘后才进入不可取消的提交尾声，随后清理 backup/marker。
    await marketplaceActivation?.finalize();
    knownMarketplaceActivation.finalize();
    return record;
  } catch (error) {
    let rollbackError: unknown;
    try {
      await knownMarketplaceActivation?.rollback();
    } catch (currentRollbackError) {
      rollbackError = currentRollbackError;
    }
    try {
      if (rollbackError === undefined) {
        await marketplaceActivation?.rollback();
      } else {
        // authority 无法恢复时保留其指向的新 manifest，避免再次制造跨代状态。
        await marketplaceActivation?.finalize();
      }
    } catch (currentRollbackError) {
      rollbackError =
        rollbackError === undefined
          ? currentRollbackError
          : appendPluginSourceCleanupError(currentRollbackError, rollbackError);
    }
    throw appendPluginSourceCleanupError(error, rollbackError);
  } finally {
    await cleanupPluginSourceBestEffort(loaded?.cleanup);
  }
}

export async function updateMarketplace(input: {
  marketplace?: string;
  signal?: AbortSignal;
  storageRoot: string;
}): Promise<KnownMarketplaceRecord[]> {
  ensureDefaultPluginMarketplaces(input.storageRoot);
  const known = loadKnownMarketplacesSync(input.storageRoot);
  const selected = input.marketplace
    ? known.filter((record) => record.id === input.marketplace)
    : known;
  if (input.marketplace && selected.length === 0) {
    throw new Error(`Marketplace not found: ${input.marketplace}`);
  }
  const updated: KnownMarketplaceRecord[] = [];
  for (const record of selected) {
    throwIfPluginOperationAborted(input.signal);

    // 受信任的刷新会重新拉取已知 marketplace 自带的 source；record.id 作为 trustedId，
    // 使官方 id 只能由原本就是该 id 的记录刷新得到。
    try {
      updated.push(
        await addMarketplace({
          signal: input.signal,
          source: record.source,
          storageRoot: input.storageRoot,
          trustedId: record.id,
        }),
      );
    } catch (error) {
      // 取消是当前 operation 的控制流，不是 Marketplace 健康状态；不得把 AbortError
      // 持久化成 refresh failure，避免后续普通商店页面误报官方源故障。
      if (input.signal?.aborted) throw error;
      const diagnostic = toValidationDiagnostic(error, record.id);
      await persistMarketplaceRefreshFailure(input.storageRoot, record.id, {
        code: diagnostic.code,
        failedAt: new Date().toISOString(),
        message: diagnostic.message,
      });
    }
  }
  return updated;
}

export async function removeMarketplace(input: {
  marketplace: string;
  storageRoot: string;
}): Promise<void> {
  const known = loadKnownMarketplacesSync(input.storageRoot).filter(
    (record) => record.id !== input.marketplace,
  );
  await writeKnownMarketplaces(input.storageRoot, known);
}
