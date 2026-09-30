import {
  getGitBackupDestinationSelection,
  getGitBackupDestinationLocation,
  getGitBackupAggregateProviders,
  getSelectedGitBackupProviders,
  gitBackupWorkspaceKey,
  type GitBackupProvider,
  type GitBackupConfig,
  type GitBackupStatus,
  type GitBackupWorkspaceTarget,
  type IGitBackupService,
} from "@lcode/services";
import type { IPlatformService } from "@lcode/shared";
import { validateGitBackupMinio, validateGitBackupOss } from "./useGitBackupDraft.js";

export function canUseSavedGitBackupConfig(
  config: GitBackupConfig | null,
  status: GitBackupStatus | null,
  target: GitBackupWorkspaceTarget | null,
  provider: GitBackupProvider = "oss",
): boolean {
  if (!target || !config || !status) return false;
  // 每个目的地单独以 Host 凭据可用性为准，不能用另一方 configured 掩盖密钥丢失。
  const configured = status.destinations
    ? status.destinations[provider]?.configured
    : provider === "oss" && status.configured;
  if (!configured) return false;
  return provider === "oss"
    ? Boolean(config.oss && !validateGitBackupOss(config.oss, config.oss).error)
    : Boolean(config.minio && !validateGitBackupMinio(config.minio, config.minio).error);
}

export function canUseSelectedGitBackupProviders(
  config: GitBackupConfig | null,
  status: GitBackupStatus | null,
  target: GitBackupWorkspaceTarget | null,
): boolean {
  if (!config) return false;
  const selected = getSelectedGitBackupProviders(config);
  return (
    selected.length > 0 &&
    selected.every((provider) => canUseSavedGitBackupConfig(config, status, target, provider))
  );
}

export function projectGitBackupDestinationSelection(
  config: GitBackupConfig,
  status: GitBackupStatus | null,
  provider: GitBackupProvider,
  selected: boolean,
): { config: GitBackupConfig; status: GitBackupStatus | null } {
  const destinationEnabled = { ...getGitBackupDestinationSelection(config), [provider]: selected };
  // Host 接受关闭最后目的地时同时关闭总调度；刷新失败也必须保留这次已确认事实。
  const enabled = config.enabled && (destinationEnabled.oss || destinationEnabled.minio);
  const nextStatus = projectGitBackupEnabledStatus(status, enabled);
  const destination = nextStatus?.destinations?.[provider];
  return {
    config: { ...config, enabled, destinationEnabled },
    status:
      nextStatus && destination
        ? {
            ...nextStatus,
            destinations: {
              ...nextStatus.destinations,
              [provider]: { ...destination, enabled: selected },
            },
          }
        : nextStatus,
  };
}

export function projectGitBackupDestinationClear(
  config: GitBackupConfig,
  status: GitBackupStatus | null,
  provider: GitBackupProvider,
): { config: GitBackupConfig; status: GitBackupStatus | null } {
  const projected = projectGitBackupDestinationSelection(config, status, provider, false);
  const next = { ...projected.config, [provider]: null };
  return { config: next, status: projectGitBackupConfigStatus(config, next, projected.status) };
}

export function projectGitBackupConfigStatus(
  previous: GitBackupConfig,
  config: GitBackupConfig,
  status: GitBackupStatus | null,
): GitBackupStatus | null {
  if (!status) return null;
  const changed = (["oss", "minio"] as const).filter(
    (provider) =>
      getGitBackupDestinationLocation(previous[provider]) !==
      getGitBackupDestinationLocation(config[provider]),
  );
  if (!changed.length) return status;
  const destinations = { ...status.destinations };
  for (const provider of changed) {
    destinations[provider] = {
      enabled: getGitBackupDestinationSelection(config)[provider],
      configured: Boolean(config[provider]),
      lastAttemptAt: null,
      lastBackupAt: null,
      lastBackupFiles: 0,
      lastBackupSize: 0,
      lastWorkspacePath: null,
      error: null,
    };
  }
  // Host 已接受的位置变更立即使旧历史失效；依据真实备份归属，而不是当前目的地开关。
  const resets = (kind: "success" | "error") =>
    getGitBackupAggregateProviders(status, kind).some((provider) => changed.includes(provider));
  const configured = (["oss", "minio"] as const).some(
    (provider) =>
      Boolean(config[provider]) &&
      (destinations[provider]?.configured ?? (provider === "oss" && status.configured)),
  );
  return {
    ...status,
    configured,
    destinations,
    ...(resets("success")
      ? {
          lastBackupAt: null,
          lastBackupFiles: 0,
          lastBackupSize: 0,
          lastWorkspacePath: null,
          lastBackupProviders: [],
        }
      : {}),
    ...(resets("error") ? { error: null, errorProviders: [] } : {}),
  };
}

export function createGitBackupRequestScope() {
  let revision = 0;
  let disposed = false;
  return {
    capture() {
      const captured = revision;
      return () => !disposed && revision === captured;
    },
    invalidate() {
      revision++;
    },
    dispose() {
      disposed = true;
    },
  };
}

export async function loadGitBackupSnapshot(
  service: IGitBackupService,
): Promise<{ config: GitBackupConfig; status: GitBackupStatus }> {
  const [config, status] = await Promise.all([service.getConfig(), service.getStatus()]);
  return { config, status };
}

export function projectGitBackupEnabledStatus(
  status: GitBackupStatus | null,
  enabled: boolean,
): GitBackupStatus | null {
  // 只回写命令已确认的开关；开启后的 due 与凭据可用性必须读 Host，不能由 UI 推算。
  return status ? { ...status, enabled, nextBackupAt: enabled ? status.nextBackupAt : null } : null;
}

export function projectGitBackupWorkspaceRemoval(
  config: GitBackupConfig,
  status: GitBackupStatus | null,
  target: GitBackupWorkspaceTarget,
): { config: GitBackupConfig; status: GitBackupStatus | null } {
  const workspaces = config.workspaces.filter(
    (workspace) => gitBackupWorkspaceKey(workspace) !== gitBackupWorkspaceKey(target),
  );
  // Host 移除最后目标会同时关闭调度；成功后刷新失败也不能继续显示旧开启状态。
  const enabled = config.enabled && workspaces.length > 0;
  return {
    config: { ...config, workspaces, enabled },
    status: projectGitBackupEnabledStatus(status, enabled),
  };
}

export function runGitBackup(
  service: IGitBackupService,
  target: GitBackupWorkspaceTarget,
  provider?: GitBackupProvider,
) {
  // 单目的地可独立手动运行；省略 provider 交由 Host 捕获所有已选目的地的一次共享快照。
  return provider
    ? service.startBackup(target.workspacePath, target.workspaceIdentity, provider)
    : service.startBackup(target.workspacePath, target.workspaceIdentity);
}

export async function exportGitBackupPrivateKey(
  service: IGitBackupService,
  platform: IPlatformService | null,
  isCurrent: () => boolean = () => true,
): Promise<"saved" | "canceled" | "stale"> {
  if (!platform?.saveFile) throw new Error("Private key export is unavailable on this platform");
  const key = await service.exportPrivateKey();
  // 切换 Host 后旧请求不能再打开文件对话框，私钥也不能进入组件状态、剪贴板或日志。
  if (!isCurrent()) return "stale";
  const data = new TextEncoder().encode(key);
  try {
    const result = await platform.saveFile({
      data: data.buffer,
      suggestedName: "lcode-git-backup-private-key.pem",
    });
    if (result.canceled) return "canceled";
    if (!result.success) throw new Error(result.error || "File export failed");
    return "saved";
  } finally {
    data.fill(0);
  }
}
