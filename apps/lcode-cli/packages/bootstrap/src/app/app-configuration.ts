import { join } from "node:path";
import { resolvePath } from "@lcode/adapters/config";
import { resolveLCodeRuntimeEnv } from "@lcode/shared";
import { getCliStorageRoot, getModelIoDir, projectIdFromDirectory } from "./paths.js";
import {
  asLocalSettingStore,
  openStartupSessionStore,
  readProjectPermissionMode,
} from "./session-store.js";
import { resolvePluginRuntimeFeatures } from "./plugin-runtime-features.js";
import { resolveAppRuntimeConfig } from "./runtime-config.js";
import { resolveBuiltInNodeReplMcpServers } from "./built-in-node-repl.js";
import { loadPluginAgentProfiles, loadLCodeAgentProfiles } from "../subagents.js";
import { resolveStartupPlugins } from "./startup-marks.js";
import type { AppStartupContext } from "./app-startup-context.js";

export async function prepareAppConfiguration(startup: AppStartupContext) {
  const { options, configResult, workingDirectory, logger, startupTimer } = startup;
  const storageRoot = resolvePath(configResult.config.storage.dir);
  const cliStorageRoot = getCliStorageRoot(storageRoot);
  const modelIoDir = getModelIoDir(
    cliStorageRoot,
    resolveLCodeRuntimeEnv(options.env ?? process.env) === "development",
  );
  const lcodeSubagentProfileOutcome = await loadLCodeAgentProfiles({
    logger,
    storageRoot,
    workingDirectory,
  });
  const lcodeSubagentProfiles = lcodeSubagentProfileOutcome.profiles;
  const pluginOutcome = resolveStartupPlugins({
    cliStorageRoot,
    configResult,
    env: options.env,
    logger,
    options,
    startupTimer,
    workingDirectory,
  });
  const pluginSubagentProfiles = loadPluginAgentProfiles({
    logger,
    plugins: pluginOutcome.plugins,
    reservedProfileNames: lcodeSubagentProfiles.map((profile) => profile.name),
    modelSelectionOverrides: lcodeSubagentProfileOutcome.pluginAgentModelSelectionOverrides,
  }).profiles;
  const pluginRuntimeFeatures = resolvePluginRuntimeFeatures(pluginOutcome);
  const builtInMcpServers = resolveBuiltInNodeReplMcpServers({
    pluginOutcome,
    workingDirectory,
  });
  // 用户目录已在 loader 前完成原地迁移；不能给项目/插件旧身份加内存兼容旁路。
  const subagentProfiles = [...lcodeSubagentProfiles, ...pluginSubagentProfiles];
  const ownsSessionStore = options.sessionStore === undefined;
  const sessionStore =
    options.sessionStore ?? (await openStartupSessionStore(configResult, startupTimer));
  const localSettingStore = asLocalSettingStore(sessionStore);
  const projectID = projectIdFromDirectory(workingDirectory);
  const persistedMode = options.runtimeConfig?.mode
    ? undefined
    : readProjectPermissionMode(localSettingStore, projectID);
  let { configuredMcpServers, runtimeConfig, untrustedProjectMcpServers } = resolveAppRuntimeConfig(
    {
      cliStorageRoot,
      configResult,
      options,
      persistedMode,
      pluginHooks: pluginOutcome.hooks,
      pluginMcpServers: pluginOutcome.mcpServers,
      builtInMcpServers,
      pluginRuntimeFeatures,
      builtInSubagentModelSelectionOverrides:
        lcodeSubagentProfileOutcome.builtInModelSelectionOverrides,
      subagentOutputRootDir: join(cliStorageRoot, "agents"),
      subagentProfiles,
      storageRoot,
      workingDirectory,
      workspaceIdentity: options.runtimeConfig?.memory?.workspaceIdentity,
    },
  );
  return {
    storageRoot,
    cliStorageRoot,
    modelIoDir,
    pluginOutcome,
    pluginRuntimeFeatures,
    ownsSessionStore,
    sessionStore,
    localSettingStore,
    projectID,
    configuredMcpServers,
    runtimeConfig,
    untrustedProjectMcpServers,
  };
}

export type PreparedAppConfiguration = Awaited<ReturnType<typeof prepareAppConfiguration>>;
