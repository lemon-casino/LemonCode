import { resolve } from "node:path";
import {
  createConfig,
  removePluginEnabledFromFileConfig,
  removePluginFromFileConfig,
  removeSuppressedBuiltinInFileConfig,
  updatePluginEnabledInFileConfig,
  updatePluginOptionsInFileConfig,
} from "@lcode/adapters/config";
import { resolveOfficialPluginRoots } from "./bundled-plugins.js";
import { withPluginStorageLock } from "../lib/plugin-storage-lock.js";
import {
  type SetLCodePluginEnabledOptions,
  type SetLCodePluginEnabledResult,
  type RestoreBuiltinPluginOptions,
  type ConfigureLCodePluginOptions,
  type ResetLCodePluginConfigOptions,
} from "./plugin-management-types.js";
import {
  resolvePluginContext,
  resolvePluginSelector,
  normalizePluginOptions,
  normalizePluginOptionKeys,
  resolvePluginConfigPath,
} from "./plugin-management-context.js";
import { resolveLCodePlugins } from "./plugin-catalog.js";

export async function setLCodePluginEnabled(
  options: SetLCodePluginEnabledOptions,
): Promise<SetLCodePluginEnabledResult> {
  const workingDirectory = resolve(options.workingDirectory ?? process.cwd());
  const configResult =
    options.configResult ??
    createConfig({
      env: options.env,
      projectConfigPath: options.projectConfigPath,
      workingDirectory,
      skipUserConfig: options.skipUserConfig,
      userConfigPath: options.userConfigPath,
    });
  const outcome = resolveLCodePlugins({
    ...options,
    configResult,
    workingDirectory,
  });
  const plugin = resolvePluginSelector(options.plugin, outcome.plugins);
  const patch = await updatePluginEnabledInFileConfig(
    resolvePluginConfigPath(options, configResult, workingDirectory),
    plugin.id,
    options.enabled,
  );

  return {
    enabled: patch.enabled,
    path: patch.path,
    plugin: {
      ...plugin,
      enabled: patch.enabled,
    },
  };
}

/**
 * 恢复一个被抑制（uninstall）的内置（官方）插件的无锁核心。
 *
 * 调用方可能已经持有同一 storageRoot 的 storage lock（例如协议 install handler），
 * 因此核心不能再次获取 promise-chain lock；公开入口再负责提供锁保护。
 */
export async function restoreBuiltinPluginCore(
  options: RestoreBuiltinPluginOptions,
): Promise<void> {
  // restore 只撤销用户的 suppression，不等于启用插件；因此不能再叠加 internal gate。
  const { configResult } = resolvePluginContext(options);
  await removeSuppressedBuiltinInFileConfig(configResult.sources.user.path, options.pluginId);
  // 重读磁盘上的最新 config（patch 后），确保抑制集合不再包含刚恢复的 id；
  // 不能复用 patch 前可能被传入的 configResult。
  const fresh = resolvePluginContext({ ...options, configResult: undefined });
  // 立即重新 seed，让插件即刻可用，无需等待下一次 resolve。
  resolveOfficialPluginRoots({
    storageRoot: fresh.pluginStorageRoot,
    suppressedBuiltins: new Set(fresh.configResult.config.plugins.suppressedBuiltins),
  });
}

export async function restoreBuiltinPlugin(options: RestoreBuiltinPluginOptions): Promise<void> {
  const { pluginStorageRoot } = resolvePluginContext(options);
  await withPluginStorageLock(pluginStorageRoot, () => restoreBuiltinPluginCore(options));
}

export async function configureLCodePlugin(options: ConfigureLCodePluginOptions): Promise<void> {
  const normalizedOptions = normalizePluginOptions(options.options);
  const clearOptionKeys = normalizePluginOptionKeys(options.clearOptionKeys);
  const { configResult, pluginStorageRoot, workingDirectory } = resolvePluginContext(options);
  const outcome = resolveLCodePlugins({
    ...options,
    configResult,
    pluginStorageRoot,
    workingDirectory,
  });
  const plugin = resolvePluginSelector(options.pluginId, outcome.plugins);
  if (options.dryRun === true) return;
  await updatePluginOptionsInFileConfig(
    resolvePluginConfigPath(options, configResult, workingDirectory),
    plugin.id,
    normalizedOptions,
    clearOptionKeys,
  );
}

/** 删除指定 scope 的 Plugin 配置键，使 Workspace scope 回退到 User。 */
export async function resetLCodePluginConfig(
  options: ResetLCodePluginConfigOptions,
): Promise<{ path: string; pluginId: string }> {
  const { configResult, workingDirectory } = resolvePluginContext(options);
  const path = resolvePluginConfigPath(options, configResult, workingDirectory);
  if (options.scope === "workspace") {
    // “恢复继承”只删除 Workspace 的 enable override。options 是独立配置维度，
    // 不能因为用户恢复开关继承而把 Workspace options/secret 一并抹掉。
    await removePluginEnabledFromFileConfig(path, options.pluginId);
  } else {
    await removePluginFromFileConfig(path, options.pluginId);
  }
  return { path, pluginId: options.pluginId };
}
