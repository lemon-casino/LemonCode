import type { IServiceAccessor } from "@lcode/services";

/**
 * 只把既有远端 RPC client 收进窗口 Host，不改变 lcode-server wire。
 * 这个窄类型固定 mixed remote workspace 真正依赖的 legacy channel，并在组合服务前做完整性校验。
 */
const LEGACY_REMOTE_WORKSPACE_RPC_CHANNELS = [
  "fileService",
  "gitService",
  "gitCheckpointService",
  "systemService",
  "terminalService",
  "lcodeTaskService",
  "lcodeAgentService",
  "lcodeSessionService",
  "fileWatcherService",
  "skillsService",
  "skillSyncService",
  "mcpSyncService",
  "pluginSyncService",
  "pluginsService",
  "pluginManagementService",
  "commandsService",
  "hooksService",
  "modelSelectionService",
  "providerSettingsService",
] as const satisfies readonly (keyof IServiceAccessor)[];

type LegacyRemoteWorkspaceRpcContract = Pick<
  IServiceAccessor,
  (typeof LEGACY_REMOTE_WORKSPACE_RPC_CHANNELS)[number]
>;

export function assertLegacyRemoteWorkspaceRpcContract(
  value: Partial<IServiceAccessor>,
): asserts value is Partial<IServiceAccessor> & LegacyRemoteWorkspaceRpcContract {
  const missing = LEGACY_REMOTE_WORKSPACE_RPC_CHANNELS.filter((channel) => {
    const service = value[channel];
    return (typeof service !== "object" || service === null) && typeof service !== "function";
  });
  if (missing.length > 0) {
    throw new Error(`Legacy remote workspace RPC channel 不完整: ${missing.join(", ")}`);
  }
}
