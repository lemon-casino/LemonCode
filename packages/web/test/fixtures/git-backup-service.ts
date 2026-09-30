import {
  getGitBackupDestinationSelection,
  getGitBackupDestinationLocation,
  getGitBackupAggregateProviders,
  getSelectedGitBackupProviders,
  gitBackupWorkspaceKey,
  normalizeGitBackupMinioConfig,
  normalizeGitBackupOssConfig,
  type GitBackupConfig,
  type GitBackupDestinationStatus,
  type GitBackupManifest,
  type GitBackupMinioConfig,
  type GitBackupProvider,
  type GitBackupStatus,
  type IGitBackupService,
} from "@lcode/services";

const STORAGE_KEY = "lcode-test-git-backup-fixture-v2";
export const workspace = {
  workspacePath: "/fixture/projects/long-workspace-name-for-mobile-layout/git-backup-regression",
  workspaceIdentity: "fixture-remote-workspace-identity",
};
const publicKey =
  "-----BEGIN PUBLIC KEY-----\nRklYVFVSRV9OT1RfQV9SRUFMX0tFWQ==\n-----END PUBLIC KEY-----";
const failureDetail =
  "HTTP 403 AccessDenied: fixture bucket permission denied; requestId=fixture-request. This is an intentionally simulated response without network access.";

export type Operation = "load" | "configure" | "test" | "backup" | "export" | "onboarding";
export type Failure = Operation | "readback" | "none";
const providers = ["oss", "minio"] as const;
function destinationStatus(enabled: boolean, configured: boolean): GitBackupDestinationStatus {
  return {
    enabled,
    configured,
    lastAttemptAt: null,
    lastBackupAt: null,
    lastBackupFiles: 0,
    lastBackupSize: 0,
    lastWorkspacePath: null,
    error: null,
  };
}
function canReuseMinioSecret(
  input: GitBackupMinioConfig,
  saved: GitBackupMinioConfig | null | undefined,
): boolean {
  if (!saved || input.accessKeyId.trim() !== saved.accessKeyId) return false;
  try {
    return new URL(input.endpoint).origin === new URL(saved.endpoint).origin;
  } catch {
    return false;
  }
}
interface AcceptedState {
  config: GitBackupConfig;
  status: GitBackupStatus;
  onboardingComplete: boolean;
}

function initialState(): AcceptedState {
  return {
    config: {
      enabled: false,
      intervalMinutes: 30,
      oss: {
        accessKeyId: "FIXTURE_ACCESS_KEY",
        accessKeySecret: "",
        bucket: "fixture-backup-bucket",
        region: "oss-cn-hangzhou",
        pathPrefix: "git-backups",
      },
      minio: null,
      destinationEnabled: { oss: true, minio: false },
      workspaces: [],
    },
    status: {
      enabled: false,
      configured: true,
      lastBackupAt: null,
      lastBackupFiles: 0,
      lastBackupSize: 0,
      lastWorkspacePath: null,
      nextBackupAt: null,
      running: false,
      error: null,
      destinations: { oss: destinationStatus(true, true), minio: destinationStatus(false, false) },
    },
    onboardingComplete: false,
  };
}

function createFixtureService() {
  const stored = sessionStorage.getItem(STORAGE_KEY);
  let state: AcceptedState = stored ? JSON.parse(stored) : initialState();
  let failure: Failure = "none";
  let held: Operation | "none" = "none";
  let backupFailure: GitBackupProvider | "none" = "none";
  const pending: Array<() => void> = [];
  const listeners = new Set<() => void>();
  const clone = <T>(value: T): T => structuredClone(value);
  const emit = () => listeners.forEach((listener) => listener());
  const persist = (next: AcceptedState) => {
    state = next;
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    emit();
  };
  const before = async (operation: Operation) => {
    const shouldFail = failure === operation;
    // 弹窗会屏蔽背景控制台；单次失败让真实重试按钮无需绕过遮罩即可恢复。
    if (shouldFail) {
      failure = "none";
      emit();
    }
    if (held === operation) {
      await new Promise<void>((resolve) => {
        pending.push(resolve);
        emit();
      });
    }
    if (shouldFail) throw new Error(failureDetail);
  };
  const service: IGitBackupService = {
    async getConfig() {
      const snapshot = clone(state.config);
      await before("load");
      return snapshot;
    },
    async getStatus() {
      const snapshot = clone(state.status);
      await before("load");
      return snapshot;
    },
    async configure(patch, target, options) {
      // 失败与校验必须先于 accepted state 写入，模拟 Host 原子提交而非配置成功后的标记失败。
      await before("configure");
      const intervalMinutes = patch.intervalMinutes ?? state.config.intervalMinutes;
      if (!Number.isInteger(intervalMinutes) || intervalMinutes < 5 || intervalMinutes > 1440)
        throw new Error("Interval must be an integer from 5 to 1440");
      let oss = state.config.oss;
      let minio = state.config.minio ?? null;
      if (patch.oss === null) oss = null;
      else if (patch.oss) {
        const reuseSecret = Boolean(oss && patch.oss.accessKeyId.trim() === oss.accessKeyId);
        oss = { ...normalizeGitBackupOssConfig(patch.oss, reuseSecret), accessKeySecret: "" };
      }
      if (patch.minio === null) minio = null;
      else if (patch.minio)
        minio = {
          ...normalizeGitBackupMinioConfig(patch.minio, canReuseMinioSecret(patch.minio, minio)),
          accessKeySecret: "",
        };
      const workspaces = [...state.config.workspaces];
      if (target) {
        const index = workspaces.findIndex(
          (item) => gitBackupWorkspaceKey(item) === gitBackupWorkspaceKey(target),
        );
        if (index < 0) workspaces.push(clone(target));
        else workspaces[index] = clone(target);
      }
      const destinationEnabled = {
        ...getGitBackupDestinationSelection(state.config),
        ...patch.destinationEnabled,
      };
      if (patch.oss && !patch.destinationEnabled) destinationEnabled.oss = true;
      if (patch.oss === null) destinationEnabled.oss = false;
      if (patch.minio === null) destinationEnabled.minio = false;
      const config: GitBackupConfig = {
        ...state.config,
        ...patch,
        intervalMinutes,
        oss,
        minio,
        destinationEnabled,
        workspaces,
      };
      const selected = getSelectedGitBackupProviders(config);
      if (!selected.length) config.enabled = false;
      if (selected.some((provider) => !config[provider]))
        throw new Error("Selected provider requires saved configuration");
      if (config.enabled && !workspaces.length)
        throw new Error("Backup requires a registered workspace");
      const destinations = { ...state.status.destinations };
      const changed = providers.filter(
        (provider) =>
          getGitBackupDestinationLocation(state.config[provider]) !==
          getGitBackupDestinationLocation(config[provider]),
      );
      const resets = (kind: "success" | "error") =>
        getGitBackupAggregateProviders(state.status, kind).some((provider) =>
          changed.includes(provider),
        );
      for (const provider of providers)
        destinations[provider] = {
          ...(changed.includes(provider)
            ? destinationStatus(false, false)
            : (destinations[provider] ?? destinationStatus(false, false))),
          enabled: destinationEnabled[provider],
          configured: Boolean(config[provider]),
        };
      persist({
        ...state,
        config,
        onboardingComplete: state.onboardingComplete || options?.completeOnboarding === true,
        status: {
          ...state.status,
          enabled: config.enabled,
          configured: Boolean(config.oss || config.minio),
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
          destinations,
          nextBackupAt: config.enabled
            ? new Date(Date.now() + intervalMinutes * 60_000).toISOString()
            : null,
        },
      });
      // 模拟写入已提交但随后的读回失败，验证 UI 不回滚已接受开关或清除命令。
      if (failure === "readback") {
        failure = "load";
        emit();
      }
    },
    async removeWorkspace(target) {
      await before("configure");
      const workspaces = state.config.workspaces.filter(
        (item) => gitBackupWorkspaceKey(item) !== gitBackupWorkspaceKey(target),
      );
      // 真正 Host 移除最后一个目标会关闭调度，测试桩必须使用同一语义。
      const enabled = workspaces.length > 0 && state.config.enabled;
      persist({
        ...state,
        config: { ...state.config, workspaces, enabled },
        status: {
          ...state.status,
          enabled,
          nextBackupAt: enabled ? state.status.nextBackupAt : null,
        },
      });
    },
    async startBackup(workspacePath, workspaceIdentity, provider) {
      const selected = provider ? [provider] : getSelectedGitBackupProviders(state.config);
      if (state.status.running) throw new Error("Backup already running");
      if (!selected.length || selected.some((item) => !state.config[item]))
        throw new Error("Backup requires saved selected providers");
      const failedProvider = backupFailure;
      const createdAt = new Date().toISOString();
      const manifest: GitBackupManifest = {
        version: "repo_backup_manifest/v1",
        workspacePath,
        workspaceIdentity,
        createdAt,
        totalFiles: 3,
        totalSize: 4096,
        entries: [],
      };
      persist({ ...state, status: { ...state.status, running: true } });
      let runError: string | null = null;
      try {
        await before("backup");
      } catch (error) {
        runError = error instanceof Error ? error.message : String(error);
      }
      // 所有目的地使用同一个模拟快照，失败不抹掉另一目的地已持久化成功状态。
      const destinations = { ...state.status.destinations };
      for (const item of selected) {
        const error = runError ?? (item === failedProvider ? `${item}: ${failureDetail}` : null);
        const previous = destinations[item] ?? destinationStatus(false, true);
        destinations[item] = {
          ...previous,
          lastAttemptAt: createdAt,
          error,
          ...(error
            ? {}
            : {
                lastBackupAt: createdAt,
                lastBackupFiles: manifest.totalFiles,
                lastBackupSize: manifest.totalSize,
                lastWorkspacePath: workspacePath,
              }),
        };
      }
      const error =
        selected
          .map((item) => destinations[item]?.error)
          .filter(Boolean)
          .join("; ") || null;
      const allSucceeded = !error;
      persist({
        ...state,
        status: {
          ...state.status,
          running: false,
          destinations,
          error,
          errorProviders: selected.filter((item) => destinations[item]?.error),
          ...(allSucceeded
            ? {
                lastBackupAt: createdAt,
                lastBackupFiles: manifest.totalFiles,
                lastBackupSize: manifest.totalSize,
                lastWorkspacePath: workspacePath,
                lastBackupProviders: selected,
              }
            : {}),
        },
      });
      if (error) throw new Error(error);
      return manifest;
    },
    async stopBackup() {
      await service.configure({ enabled: false });
    },
    async testConnection(input, provider = "oss") {
      if (provider === "minio") {
        if (!("endpoint" in input)) throw new Error("MinIO endpoint required");
        normalizeGitBackupMinioConfig(input, canReuseMinioSecret(input, state.config.minio));
      } else {
        const reuseSecret = Boolean(
          state.config.oss && input.accessKeyId.trim() === state.config.oss.accessKeyId,
        );
        normalizeGitBackupOssConfig(input, reuseSecret);
      }
      try {
        await before("test");
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    async exportPrivateKey() {
      await before("export");
      return "FIXTURE_ONLY_NOT_A_REAL_PRIVATE_KEY";
    },
    async getPublicKey() {
      return publicKey;
    },
    async hasCompletedOnboarding() {
      await before("load");
      return state.onboardingComplete;
    },
    async markOnboardingComplete() {
      await before("onboarding");
      persist({ ...state, onboardingComplete: true });
    },
  };
  return {
    service,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot: () => state,
    pendingCount: () => pending.length,
    failureSnapshot: () => failure,
    backupFailureSnapshot: () => backupFailure,
    setBackupFailure(value: typeof backupFailure) {
      backupFailure = value;
      emit();
    },
    setFailure(value: typeof failure) {
      failure = value;
      emit();
    },
    setHeld(value: typeof held) {
      held = value;
    },
    release() {
      pending.splice(0).forEach((resolve) => resolve());
      emit();
    },
    reset() {
      failure = "none";
      held = "none";
      backupFailure = "none";
      persist(initialState());
    },
  };
}

export const fixture = createFixtureService();
export { platform } from "./git-backup-platform.js";
