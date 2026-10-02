import {
  lcodePluginsConfigureParamsSchema,
  lcodePluginsResetConfigParamsSchema,
  lcodePluginsInstallParamsSchema,
  lcodePluginsMarketplaceAddParamsSchema,
  lcodePluginsMarketplaceRemoveParamsSchema,
  lcodePluginsMarketplaceUpdateParamsSchema,
  lcodePluginsOverviewParamsSchema,
  lcodePluginsListParamsSchema,
  lcodePluginsSetEnabledParamsSchema,
  lcodePluginsUninstallParamsSchema,
  lcodePluginsUpdateParamsSchema,
  lcodePluginsValidateParamsSchema,
  lcodePluginsDescribeParamsSchema,
  lcodePluginsRestoreBuiltinParamsSchema,
  type LCodeInstalledPluginSummary,
  type LCodePluginComponentGroup,
  type LCodePluginDiagnostic,
  type LCodePluginsConfigureResult,
  type LCodePluginsDescribeResult,
  type LCodePluginsInstallResult,
  type LCodePluginsListResult,
  type LCodePluginsMarketplaceMutationResult,
  type LCodePluginsOverviewResult,
  type LCodePluginsRestoreBuiltinResult,
  type LCodePluginsSetEnabledResult,
  type LCodePluginsUninstallResult,
  type LCodePluginsValidateResult,
} from "@lcode/shared";

import {
  addLCodePluginMarketplace,
  configureLCodePlugin,
  describeLCodePlugin,
  getLCodePluginsOverview,
  installLCodeMarketplacePlugin,
  removeLCodePluginMarketplace,
  resolveLCodePlugins,
  resetLCodePluginConfig,
  restoreBuiltinPlugin as restoreBuiltinPluginCore,
  setLCodePluginEnabled,
  uninstallLCodeMarketplacePlugin,
  updateLCodePluginMarketplace,
  validateLCodePlugin,
} from "../plugins.js";

import { listInstalledPluginRecords } from "@lcode/adapters/plugins";

import { withPluginStorageLock } from "../lib/plugin-storage-lock.js";

import { getCliStorageRoot, getPluginStorageRoot } from "../app/paths.js";

import { createConfig, resolvePath, type ConfigResult } from "@lcode/adapters/config";

import { parseParams, type LCodeProtocolAgentServerContext } from "./server-types.js";

import {
  toPluginInfo,
  createMissingConfiguredPluginInfos,
  toPluginDiagnostic,
  toMarketplaceSummary,
  toAvailablePluginSummary,
  toInstalledPluginSummary,
} from "./plugin-projection.js";

function createPluginConfigView(
  context: LCodeProtocolAgentServerContext,
  workspacePath: string,
  configScope: "user" | "workspace" | undefined,
): ConfigResult {
  // Settings 的 User 与 Workspace 现在是同一批 Host Plugin 的两个配置视图。
  // User 视图若继续加载 project config，会把 Workspace override 投影成 User 当前值；
  // 不传 workingDirectory 可保留 User/default 层，同时仍由调用方的 workspacePath 决定
  // package storage 和相对执行上下文。
  return createConfig({
    env: context.deps?.env,
    ...(configScope === "user" ? {} : { workingDirectory: workspacePath }),
  });
}

export async function listPlugins(
  context: LCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<LCodePluginsListResult> {
  const params = parseParams(lcodePluginsListParamsSchema, rawParams);
  const configResult = createPluginConfigView(
    context,
    params.workspace.workspacePath,
    params.configScope,
  );
  const outcome = resolveLCodePlugins({
    configResult,
    logger: context.logger,
    workingDirectory: params.workspace.workspacePath,
  });
  const plugins = outcome.plugins.map((plugin) => toPluginInfo(plugin, configResult));
  return {
    plugins: [
      ...plugins,
      ...createMissingConfiguredPluginInfos(
        configResult,
        new Set(plugins.map((plugin) => plugin.id)),
      ),
    ],
    diagnostics: outcome.diagnostics.map(toPluginDiagnostic),
  };
}

export async function setPluginEnabled(
  context: LCodeProtocolAgentServerContext,
  rawParams: unknown,
  abortSignal?: AbortSignal,
): Promise<LCodePluginsSetEnabledResult> {
  const params = parseParams(lcodePluginsSetEnabledParamsSchema, rawParams);
  abortSignal?.throwIfAborted();
  const result = await setLCodePluginEnabled({
    enabled: params.enabled,
    logger: context.logger,
    plugin: params.pluginId,
    scope: params.scope,
    workingDirectory: params.workspace.workspacePath,
  });
  // 启用配置写入当前不可回滚；若取消在 IO 期间到达，只阻断后续响应和 UI 写入。
  abortSignal?.throwIfAborted();
  return {
    plugin: {
      ...toPluginInfo(result.plugin),
      enabledSource: params.scope ?? "user",
    },
    enabled: result.enabled,
  };
}

export async function getPluginsOverview(
  context: LCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<LCodePluginsOverviewResult> {
  const params = parseParams(lcodePluginsOverviewParamsSchema, rawParams);
  const overview = getLCodePluginsOverview({
    configResult: createPluginConfigView(
      context,
      params.workspace.workspacePath,
      params.configScope,
    ),
    logger: context.logger,
    workingDirectory: params.workspace.workspacePath,
  });
  return {
    marketplaces: overview.marketplaces.map(toMarketplaceSummary),
    availablePlugins: overview.availablePlugins.map(toAvailablePluginSummary),
    installedPlugins: overview.installedPlugins.map(toInstalledPluginSummary),
    restorableBuiltins: overview.restorableBuiltins.map(toAvailablePluginSummary),
    diagnostics: overview.diagnostics.map(toPluginDiagnostic),
    capability: { supported: true },
  };
}

export async function addPluginMarketplace(
  context: LCodeProtocolAgentServerContext,
  rawParams: unknown,
  abortSignal?: AbortSignal,
): Promise<LCodePluginsMarketplaceMutationResult> {
  const params = parseParams(lcodePluginsMarketplaceAddParamsSchema, rawParams);
  const pluginStorageRoot = resolvePluginStorageRoot(params.workspace.workspacePath);
  const marketplace = await withPluginStorageLock(pluginStorageRoot, async () =>
    addLCodePluginMarketplace({
      abortSignal,
      dryRun: params.dryRun,
      logger: context.logger,
      source: params.source,
      workingDirectory: params.workspace.workspacePath,
    }),
  );
  return { marketplace: toMarketplaceSummary(marketplace), diagnostics: [] };
}

export async function removePluginMarketplace(
  context: LCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<LCodePluginsMarketplaceMutationResult> {
  const params = parseParams(lcodePluginsMarketplaceRemoveParamsSchema, rawParams);
  const pluginStorageRoot = resolvePluginStorageRoot(params.workspace.workspacePath);
  await withPluginStorageLock(pluginStorageRoot, async () =>
    removeLCodePluginMarketplace({
      logger: context.logger,
      marketplace: params.marketplace,
      workingDirectory: params.workspace.workspacePath,
    }),
  );
  return { diagnostics: [] };
}

export async function updatePluginMarketplace(
  context: LCodeProtocolAgentServerContext,
  rawParams: unknown,
  abortSignal?: AbortSignal,
): Promise<LCodePluginsMarketplaceMutationResult> {
  const params = parseParams(lcodePluginsMarketplaceUpdateParamsSchema, rawParams);
  const pluginStorageRoot = resolvePluginStorageRoot(params.workspace.workspacePath);
  const result = await withPluginStorageLock(pluginStorageRoot, async () =>
    updateLCodePluginMarketplace({
      abortSignal,
      logger: context.logger,
      marketplace: params.marketplace,
      workingDirectory: params.workspace.workspacePath,
    }),
  );
  return {
    marketplaces: result.marketplaces.map(toMarketplaceSummary),
    diagnostics: result.diagnostics.map(toPluginDiagnostic),
  };
}

export async function installPlugin(
  context: LCodeProtocolAgentServerContext,
  rawParams: unknown,
  abortSignal?: AbortSignal,
): Promise<LCodePluginsInstallResult> {
  const params = parseParams(lcodePluginsInstallParamsSchema, rawParams);
  const pluginStorageRoot = resolvePluginStorageRoot(params.workspace.workspacePath);
  const result = await withPluginStorageLock(pluginStorageRoot, async () =>
    installLCodeMarketplacePlugin({
      abortSignal,
      dryRun: params.dryRun,
      logger: context.logger,
      marketplace: params.marketplace,
      pluginName: params.pluginName,
      scope: params.scope,
      workingDirectory: params.workspace.workspacePath,
    }),
  );
  return {
    dependencyClosure: result.dependencyClosure,
    installedPlugins: result.installedPlugins.map(toInstalledPluginSummary),
    diagnostics: result.diagnostics.map(toPluginDiagnostic),
  };
}

export async function uninstallPlugin(
  context: LCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<LCodePluginsUninstallResult> {
  const params = parseParams(lcodePluginsUninstallParamsSchema, rawParams);
  const removed = await uninstallLCodeMarketplacePlugin({
    logger: context.logger,
    marketplace: params.marketplace,
    pluginId: params.pluginId,
    pluginName: params.pluginName,
    removeCache: params.removeCache,
    workingDirectory: params.workspace.workspacePath,
  });
  return {
    ...(removed ? { removedPlugin: toInstalledPluginSummary(removed) } : {}),
    diagnostics: [],
  };
}

export async function updatePlugin(
  context: LCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<LCodePluginsInstallResult> {
  const params = parseParams(lcodePluginsUpdateParamsSchema, rawParams);
  const pluginStorageRoot = resolvePluginStorageRoot(params.workspace.workspacePath);
  const installed = listInstalledPluginRecords(pluginStorageRoot).filter((record) => {
    if (params.pluginId) return record.id === params.pluginId;
    if (params.marketplace) return record.marketplace === params.marketplace;
    return true;
  });
  // 与 uninstall 一样把整个重装循环串行化到同一 storageRoot 的 in-process 锁里，
  // 避免并发 update/install 交错读改写 installed_plugins.json / cache。
  return withPluginStorageLock(pluginStorageRoot, async () => {
    const installedPlugins: LCodeInstalledPluginSummary[] = [];
    const dependencyClosure: string[] = [];
    // 聚合每条记录重装产生的诊断：installLCodeMarketplacePlugin 失败时不抛错，而是返回
    // CLI 形态的 PluginDiagnostic（见其错误分支的 toMarketplaceInstallDiagnostic），
    // 这里逐条经协议侧 toPluginDiagnostic 投影成 LCodePluginDiagnostic 回传，
    // 让失败的重装显式暴露，而不是静默"成功"。
    const diagnostics: LCodePluginDiagnostic[] = [];
    for (const record of installed) {
      const result = await installLCodeMarketplacePlugin({
        logger: context.logger,
        marketplace: record.marketplace,
        pluginName: record.name,
        scope: record.scope,
        workingDirectory: params.workspace.workspacePath,
      });
      installedPlugins.push(...result.installedPlugins.map(toInstalledPluginSummary));
      dependencyClosure.push(...result.dependencyClosure);
      diagnostics.push(...result.diagnostics.map(toPluginDiagnostic));
    }
    return { dependencyClosure, installedPlugins, diagnostics };
  });
}

// 恢复一个被抑制（"卸载"）的内置插件：清除 suppressedBuiltins 标记并立即重新 seed。
// bootstrap 侧的同名函数被别名为 restoreBuiltinPluginCore，避免与本协议处理器重名。
export async function restoreBuiltinPlugin(
  context: LCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<LCodePluginsRestoreBuiltinResult> {
  const params = parseParams(lcodePluginsRestoreBuiltinParamsSchema, rawParams);
  await restoreBuiltinPluginCore({
    logger: context.logger,
    pluginId: params.pluginId,
    workingDirectory: params.workspace.workspacePath,
  });
  return { pluginId: params.pluginId, diagnostics: [] };
}

export async function configurePlugin(
  context: LCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<LCodePluginsConfigureResult> {
  const params = parseParams(lcodePluginsConfigureParamsSchema, rawParams);
  await configureLCodePlugin({
    clearOptionKeys: params.clearOptionKeys,
    dryRun: params.dryRun,
    logger: context.logger,
    options: params.options,
    pluginId: params.pluginId,
    scope: params.scope,
    workingDirectory: params.workspace.workspacePath,
  });
  return { pluginId: params.pluginId, diagnostics: [] };
}

export async function resetPluginConfig(
  context: LCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<LCodePluginsConfigureResult> {
  const params = parseParams(lcodePluginsResetConfigParamsSchema, rawParams);
  await resetLCodePluginConfig({
    logger: context.logger,
    pluginId: params.pluginId,
    scope: params.scope,
    workingDirectory: params.workspace.workspacePath,
  });
  return { pluginId: params.pluginId, diagnostics: [] };
}

export async function validatePlugin(
  context: LCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<LCodePluginsValidateResult> {
  const params = parseParams(lcodePluginsValidateParamsSchema, rawParams);
  const pluginStorageRoot = resolvePluginStorageRoot(params.workspace.workspacePath);
  const diagnostics = await withPluginStorageLock(pluginStorageRoot, async () =>
    validateLCodePlugin({
      logger: context.logger,
      marketplace: params.marketplace,
      pluginName: params.pluginName,
      source: params.source,
      workingDirectory: params.workspace.workspacePath,
    }),
  );
  return {
    ok: diagnostics.every((diagnostic) => diagnostic.severity !== "error"),
    diagnostics: diagnostics.map(toPluginDiagnostic),
    compatibility: {
      runnable: ["skills", "commands", "hooks", "mcpServers", "userConfig"],
      diagnosticOnly: ["agents", "lspServers", "outputStyles", "channels", "settings"],
      unsupported: ["mcpb", "dxt", "npm", "hostPattern", "pathPattern"],
    },
  };
}

export async function describePlugin(
  context: LCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<LCodePluginsDescribeResult> {
  const params = parseParams(lcodePluginsDescribeParamsSchema, rawParams);
  const pluginStorageRoot = resolvePluginStorageRoot(params.workspace.workspacePath);
  const result = await withPluginStorageLock(pluginStorageRoot, async () =>
    describeLCodePlugin({
      logger: context.logger,
      marketplace: params.marketplace,
      pluginName: params.pluginName,
      workingDirectory: params.workspace.workspacePath,
    }),
  );
  const components: LCodePluginComponentGroup[] = result.components.map((group) => ({
    kind: group.kind,
    items: group.items.map((item) => ({
      name: item.name,
      ...(item.description ? { description: item.description } : {}),
    })),
  }));
  const diagnostics = result.diagnostics.map(toPluginDiagnostic);
  return {
    components,
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
    ...(result.metadata ? { metadata: result.metadata } : {}),
  };
}

function resolvePluginStorageRoot(workingDirectory: string): string {
  const config = createConfig({ workingDirectory });
  const storageRoot = resolvePath(config.config.storage.dir);
  return getPluginStorageRoot(getCliStorageRoot(storageRoot));
}
