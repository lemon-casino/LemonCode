import { randomUUID } from "node:crypto";
import { withFileLock } from "@lcode/shared/node";
import type { ICredentialService } from "../credential/credential.js";
import {
  getGitBackupDestinationSelection,
  getSelectedGitBackupProviders,
  getGitBackupAggregateProviders,
  getGitBackupDestinationLocation,
  normalizeGitBackupOssConfig,
  normalizeGitBackupMinioConfig,
  gitBackupWorkspaceKey,
  type GitBackupConfig,
  type GitBackupConfigUpdate,
  type GitBackupStatus,
  type GitBackupDestinationConfig,
  type GitBackupDestinationStatus,
  type GitBackupProvider,
  type GitBackupWorkspaceTarget,
  type GitBackupOssConfig,
  type GitBackupMinioConfig,
} from "./gitBackup.js";
import {
  BACKUP_PROVIDERS as PROVIDERS,
  EMPTY_BACKUP_DESTINATION_STATE,
  createBackupDocumentAccess,
  isRecord,
  normalizeDestination,
  parseState,
  validateBackupTarget,
  validateProvider,
  validateSelection,
  type BackupDocument,
  type BackupStoreOptions,
  type GitBackupStoredState,
} from "./gitBackupStoreDocument.js";
export {
  EMPTY_BACKUP_DESTINATION_STATE,
  EMPTY_BACKUP_STATE,
  validateBackupTarget,
  type GitBackupStoredDestinationState,
  type GitBackupStoredState,
} from "./gitBackupStoreDocument.js";

export interface GitBackupAdmissionDestination {
  provider: GitBackupProvider;
  config?: GitBackupDestinationConfig;
  error?: string;
}
export interface GitBackupAdmission {
  config: GitBackupConfig;
  destinations: GitBackupAdmissionDestination[];
}
export type BackupCredentials = Pick<ICredentialService, "load" | "save" | "delete">;
const providerName = (provider: GitBackupProvider) => (provider === "oss" ? "OSS" : "MinIO");

export function createBackupStore(
  dataDir: string,
  credentials?: BackupCredentials,
  options: BackupStoreOptions = {},
) {
  const { configPath, save, readDocument, read } = createBackupDocumentAccess(
    dataDir,
    options,
    credentials,
  );
  async function resolveFrom(
    document: BackupDocument,
    provider: GitBackupProvider,
    input: GitBackupDestinationConfig,
  ): Promise<GitBackupDestinationConfig> {
    const normalized = normalizeDestination(provider, input);
    if (!credentials) throw new Error("Backup credential service is unavailable");
    if (normalized.accessKeySecret) return normalized;
    const saved = document.config[provider];
    if (saved?.accessKeyId !== normalized.accessKeyId)
      throw new Error("Changing AccessKey ID requires a new secret");
    if (
      provider === "minio" &&
      (saved as GitBackupMinioConfig).endpoint !== (normalized as GitBackupMinioConfig).endpoint
    )
      throw new Error("Changing MinIO endpoint requires a new secret");
    const reference = document.credentialReferences[provider];
    let secret: string | null = null;
    try {
      secret = reference ? await credentials.load(reference) : null;
    } catch {
      // 凭据后端错误可能携带敏感细节，跨 RPC 只返回目的地级无凭据诊断。
      throw new Error(`${providerName(provider)} credentials could not be loaded`);
    }
    if (!secret) throw new Error(`${providerName(provider)} AccessKey Secret is not configured`);
    return normalizeDestination(provider, { ...normalized, accessKeySecret: secret });
  }
  async function configure(
    partial: GitBackupConfigUpdate,
    workspace: GitBackupWorkspaceTarget | undefined,
    now: number,
    configureOptions?: { completeOnboarding?: boolean },
  ): Promise<void> {
    await withFileLock(configPath, async () => {
      if (!isRecord(partial)) throw new Error("Invalid Git backup configuration update");
      if (
        configureOptions &&
        (!isRecord(configureOptions) ||
          (configureOptions.completeOnboarding !== undefined &&
            typeof configureOptions.completeOnboarding !== "boolean"))
      )
        throw new Error("Invalid Git backup onboarding option");
      if (partial.destinationEnabled !== undefined) validateSelection(partial.destinationEnabled);
      const document = await readDocument();
      const current = document.config;
      const currentSelection = getGitBackupDestinationSelection(current);
      const selection = { ...currentSelection, ...partial.destinationEnabled };
      // 老 RPC 保存新 OSS 槽即默认选中；新调用显式携带选择状态，不能因保存而偷偷启用。
      if (partial.destinationEnabled === undefined && partial.oss && !current.oss)
        selection.oss = true;
      const updated: GitBackupConfig = {
        ...current,
        destinationEnabled: selection,
        ...(partial.enabled !== undefined ? { enabled: partial.enabled } : {}),
        ...(partial.intervalMinutes !== undefined
          ? { intervalMinutes: partial.intervalMinutes }
          : {}),
        ...(partial.oss !== undefined
          ? { oss: partial.oss === null ? null : normalizeGitBackupOssConfig(partial.oss, true) }
          : {}),
        ...(partial.minio !== undefined
          ? {
              minio:
                partial.minio === null ? null : normalizeGitBackupMinioConfig(partial.minio, true),
            }
          : {}),
      };
      if (
        typeof updated.enabled !== "boolean" ||
        !Number.isInteger(updated.intervalMinutes) ||
        updated.intervalMinutes < 5 ||
        updated.intervalMinutes > 1440
      )
        throw new Error("Backup interval must be an integer between 5 and 1440 minutes");
      if (workspace) {
        const target = validateBackupTarget(workspace);
        updated.workspaces = [
          ...current.workspaces.filter(
            (item) => gitBackupWorkspaceKey(item) !== gitBackupWorkspaceKey(target),
          ),
          target,
        ];
      }
      const selected = getSelectedGitBackupProviders(updated);
      if (!selected.length) {
        if (partial.enabled === true)
          throw new Error(
            "Enabling backup requires a selected destination and a registered workspace",
          );
        updated.enabled = false;
      }
      if (
        updated.enabled &&
        (!updated.workspaces.length || selected.some((provider) => !updated[provider]))
      )
        throw new Error(
          "Enabling backup requires configured destinations and a registered workspace",
        );
      const references = { ...document.credentialReferences };
      const resolved = new Map<GitBackupProvider, GitBackupDestinationConfig>();
      for (const provider of PROVIDERS) {
        const input = updated[provider];
        const newlySelected = selection[provider] && !currentSelection[provider];
        if (!input) {
          references[provider] = null;
          if (newlySelected) throw new Error(`${providerName(provider)} is not configured`);
        } else if (
          partial[provider] !== undefined ||
          newlySelected ||
          (partial.enabled === true && selection[provider])
        ) {
          resolved.set(provider, await resolveFrom(document, provider, input));
        }
      }
      const stagedReferences: string[] = [];
      try {
        for (const [provider, input] of resolved) {
          if (input.accessKeySecret && partial[provider]?.accessKeySecret?.trim()) {
            // 所有新 Secret 使用不可变引用；失败清理 staged 写入，旧引用供在途 admission 使用。
            const reference = `git-backup:${provider}:${randomUUID()}:${input.accessKeyId}`;
            stagedReferences.push(reference);
            try {
              await credentials!.save(reference, input.accessKeySecret);
            } catch {
              // 保存异常同样可能携带 Secret；仍由外层统一回滚所有 staged 引用。
              throw new Error(`${providerName(provider)} credentials could not be saved`);
            }
            references[provider] = reference;
          }
          if (provider === "oss")
            updated.oss = { ...(input as GitBackupOssConfig), accessKeySecret: "" };
          else updated.minio = { ...(input as GitBackupMinioConfig), accessKeySecret: "" };
        }
        const destinations = { ...document.state.destinations };
        const successProviders = getGitBackupAggregateProviders(document.state, "success");
        const errorProviders = getGitBackupAggregateProviders(document.state, "error");
        let resetAggregate = false;
        let resetError = false;
        for (const provider of PROVIDERS) {
          if (
            getGitBackupDestinationLocation(current[provider]) !==
            getGitBackupDestinationLocation(updated[provider])
          ) {
            destinations[provider] = { ...EMPTY_BACKUP_DESTINATION_STATE };
            // 显式手动备份可能未选中，历史归属不能用当前开关推测。
            resetAggregate ||= successProviders.includes(provider);
            resetError ||= errorProviders.includes(provider);
          }
        }
        await save({
          config: updated,
          credentialReferences: references,
          onboardingComplete:
            document.onboardingComplete || configureOptions?.completeOnboarding === true,
          state: {
            ...document.state,
            ...(resetAggregate
              ? {
                  lastBackupAt: null,
                  lastBackupFiles: 0,
                  lastBackupSize: 0,
                  lastWorkspacePath: null,
                  lastBackupProviders: [],
                }
              : {}),
            ...(resetError ? { error: null, errorProviders: [] } : {}),
            destinations,
            nextDueAt: updated.enabled
              ? !current.enabled ||
                current.intervalMinutes !== updated.intervalMinutes ||
                document.state.nextDueAt === null
                ? now + updated.intervalMinutes * 60_000
                : document.state.nextDueAt
              : null,
          },
        });
      } catch (error) {
        await Promise.all(
          stagedReferences.map((reference) =>
            credentials!.delete(reference).catch(() => undefined),
          ),
        );
        throw error;
      }
    });
  }
  async function updateState(
    change: (state: GitBackupStoredState, config: GitBackupConfig) => GitBackupStoredState,
  ) {
    await withFileLock(configPath, async () => {
      const document = await readDocument();
      await save({ ...document, state: parseState(change(document.state, document.config)) });
    });
  }
  async function removeWorkspace(target: GitBackupWorkspaceTarget) {
    const key = gitBackupWorkspaceKey(validateBackupTarget(target));
    await withFileLock(configPath, async () => {
      const document = await readDocument();
      const workspaces = document.config.workspaces.filter(
        (item) => gitBackupWorkspaceKey(item) !== key,
      );
      const enabled = document.config.enabled && workspaces.length > 0;
      await save({
        ...document,
        config: { ...document.config, enabled, workspaces },
        state: { ...document.state, nextDueAt: enabled ? document.state.nextDueAt : null },
      });
    });
  }
  async function loadAdmission(provider?: GitBackupProvider): Promise<GitBackupAdmission> {
    if (provider !== undefined) validateProvider(provider);
    // admission 配置和引用在同一锁内读取及解析；并发保存不能把新凭据配到旧 endpoint。
    return withFileLock(configPath, async () => {
      const document = await readDocument();
      const destinations = await Promise.all(
        (provider ? [provider] : getSelectedGitBackupProviders(document.config)).map(
          async (provider) => {
            try {
              const input = document.config[provider];
              if (!input) throw new Error(`${providerName(provider)} is not configured`);
              return { provider, config: await resolveFrom(document, provider, input) };
            } catch (error) {
              return {
                provider,
                error:
                  error instanceof Error
                    ? error.message
                    : "Git backup credentials could not be loaded",
              };
            }
          },
        ),
      );
      return { config: document.config, destinations };
    });
  }
  async function getStatus(): Promise<GitBackupStatus> {
    const { config, state, credentialReferences } = await read();
    const selection = getGitBackupDestinationSelection(config);
    const destinations: Partial<Record<GitBackupProvider, GitBackupDestinationStatus>> = {};
    for (const provider of PROVIDERS) {
      const input = config[provider];
      const reference = credentialReferences[provider];
      let configured = false;
      let readinessError: string | null = null;
      try {
        const secret = input && credentials && reference ? await credentials.load(reference) : null;
        if (input && secret) {
          normalizeDestination(provider, { ...input, accessKeySecret: secret });
          configured = true;
        }
      } catch {
        // 单个凭据读取异常不能遮住健康目的地，也不能把后端敏感错误传播到状态。
        readinessError = `${providerName(provider)} credentials could not be loaded`;
      }
      destinations[provider] = {
        ...EMPTY_BACKUP_DESTINATION_STATE,
        ...state.destinations?.[provider],
        enabled: selection[provider],
        configured,
        error: state.destinations?.[provider]?.error ?? readinessError,
      };
    }
    return {
      enabled: config.enabled,
      configured: PROVIDERS.some((provider) => destinations[provider]!.configured),
      lastBackupAt: state.lastBackupAt,
      lastBackupFiles: state.lastBackupFiles,
      lastBackupSize: state.lastBackupSize,
      lastWorkspacePath: state.lastWorkspacePath,
      running: state.running,
      error: state.error,
      destinations,
      lastBackupProviders: state.lastBackupProviders,
      errorProviders: state.errorProviders,
      nextBackupAt:
        config.enabled && state.nextDueAt !== null ? new Date(state.nextDueAt).toISOString() : null,
    };
  }
  return {
    loadConfig: async () => (await read()).config,
    loadState: async () => (await read()).state,
    resolveDestination: async (provider: GitBackupProvider, input: GitBackupDestinationConfig) =>
      resolveFrom(await read(), provider, input),
    resolveOss: async (input: GitBackupOssConfig) =>
      (await resolveFrom(await read(), "oss", input)) as GitBackupOssConfig,
    loadAdmission,
    hasCompletedOnboarding: async () => (await read()).onboardingComplete,
    async markOnboardingComplete() {
      await withFileLock(configPath, async () =>
        save({ ...(await readDocument()), onboardingComplete: true }),
      );
    },
    updateState,
    configure,
    removeWorkspace,
    getStatus,
  };
}
