import { createHash, randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { acquireFileLock } from "@lcode/shared/node";
import { createServiceLogger } from "../logger/serviceLogger.js";
import type {
  GitBackupManifest,
  GitBackupConfig,
  GitBackupProvider,
  GitBackupDestinationResult,
  GitBackupMinioConfig,
  GitBackupOssConfig,
  GitBackupWorkspaceTarget,
  IGitBackupService,
} from "./gitBackup.js";
import {
  gitBackupWorkspaceKey,
  getSelectedGitBackupProviders,
  getGitBackupDestinationLocation,
} from "./gitBackup.js";
import { ensureKeyPair, encryptBuffer, readPrivateKey } from "./gitBackupEncryption.js";
import { testOssConnection, type OssRequestOptions } from "./gitBackupOssClient.js";
import { testMinioConnection } from "./gitBackupMinioClient.js";
import { uploadBackupDestination, backupDestinationFailure } from "./gitBackupDestinations.js";
import { captureGitSnapshot, type GitBackupSnapshotOptions } from "./gitBackupSnapshot.js";
import {
  createBackupStore,
  validateBackupTarget,
  EMPTY_BACKUP_DESTINATION_STATE,
  type GitBackupAdmission,
  type BackupCredentials,
} from "./gitBackupStore.js";

export interface GitBackupServiceOptions extends OssRequestOptions, GitBackupSnapshotOptions {
  credentialService?: BackupCredentials;
  schedulerPollMs?: number;
}

export type GitBackupServiceRuntime = IGitBackupService & { dispose(): void };

export function createGitBackupService(
  dataDir: string,
  options: GitBackupServiceOptions = {},
): GitBackupServiceRuntime {
  const store = createBackupStore(dataDir, options.credentialService);
  const logger = createServiceLogger("git-backup");
  let schedulerFailureLogged = false;
  const now = options.now ?? Date.now;
  let disposed = false;
  let polling = false;

  async function executionLock(): Promise<(() => Promise<void>) | null> {
    await mkdir(dataDir, { recursive: true });
    try {
      // 活跃进程锁不会按时间过期；非阻塞申请避免多个 Host 排队重复执行同一周期。
      return await acquireFileLock(join(dataDir, "git-backup-execution"), [10], 100, 30);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "LCODE_FILE_LOCK_TIMEOUT") return null;
      throw error;
    }
  }

  async function recordResults(
    admission: GitBackupAdmission,
    target: GitBackupWorkspaceTarget,
    attemptedAt: string,
    results: GitBackupDestinationResult[],
    manifest?: GitBackupManifest,
  ) {
    await store.updateState((state, current) => {
      const destinations = { ...state.destinations };
      // 旧地址的成功和失败都不能污染替换配置，独立与全局结果必须使用同一过滤条件。
      const currentResults = results.filter(
        (result) =>
          getGitBackupDestinationLocation(admission.config[result.provider]) ===
          getGitBackupDestinationLocation(current[result.provider]),
      );
      const sameLocations = currentResults.length === results.length;
      for (const result of currentResults) {
        const provider = result.provider;
        const previous = destinations[provider] ?? { ...EMPTY_BACKUP_DESTINATION_STATE };
        destinations[provider] = {
          ...previous,
          lastAttemptAt: attemptedAt,
          ...(result.ok && manifest
            ? {
                lastBackupAt: manifest.createdAt,
                lastBackupFiles: manifest.totalFiles,
                lastBackupSize: manifest.totalSize,
                lastWorkspacePath: target.workspacePath,
              }
            : {}),
          error: result.ok ? null : (result.error ?? "Git backup failed"),
        };
      }
      const successful = results.every((result) => result.ok) && manifest && sameLocations;
      return {
        ...state,
        running: false,
        destinations,
        ...(successful
          ? {
              lastBackupAt: manifest.createdAt,
              lastBackupFiles: manifest.totalFiles,
              lastBackupSize: manifest.totalSize,
              lastWorkspacePath: target.workspacePath,
              lastBackupProviders: results.map((result) => result.provider),
            }
          : {}),
        ...(currentResults.length
          ? {
              error: currentResults.some((result) => !result.ok)
                ? backupDestinationFailure(currentResults).message
                : null,
              errorProviders: currentResults
                .filter((result) => !result.ok)
                .map((result) => result.provider),
            }
          : {}),
      };
    });
  }

  async function backup(
    target: GitBackupWorkspaceTarget,
    provider?: GitBackupProvider,
    onFailure?: (
      config: GitBackupConfig | undefined,
      results: GitBackupDestinationResult[],
      message: string,
    ) => void,
  ): Promise<GitBackupManifest> {
    await store.updateState((state) => ({
      ...state,
      running: true,
      error: null,
      errorProviders: [],
    }));
    let admission: GitBackupAdmission | undefined;
    let results: GitBackupDestinationResult[] = [];
    const attemptedAt = new Date(now()).toISOString();
    let recorded = false;
    try {
      admission = await store.loadAdmission(provider);
      if (!admission.destinations.length)
        throw new Error("Backup destinations are not configured or no destination is selected");
      const ready = admission.destinations.filter((destination) => destination.config);
      if (!ready.length)
        throw backupDestinationFailure(
          admission.destinations.map((destination) => ({
            provider: destination.provider,
            ok: false,
            error: destination.error,
          })),
        );
      const snapshot = await captureGitSnapshot(target.workspacePath, options);
      const manifest: GitBackupManifest = {
        version: "repo_backup_manifest/v1",
        ...target,
        createdAt: attemptedAt,
        totalFiles: snapshot.entries.length,
        totalSize: snapshot.entries.reduce((sum, entry) => sum + entry.size, 0),
        entries: snapshot.entries,
      };
      const keyPair = await ensureKeyPair(dataDir);
      const payload = encryptBuffer(snapshot.packed, keyPair.publicKey);
      const workspaceHash = createHash("sha256")
        .update(gitBackupWorkspaceKey(target))
        .digest("hex")
        .slice(0, 24);
      const timestamp = attemptedAt.replace(/[:.]/g, "-");
      const relativeKey = `${workspaceHash}/backup-${timestamp}-${randomBytes(8).toString("hex")}`;
      // 各目的地独立完成；全部 settled 后才能记录总结果和释放跨 Host 执行锁。
      results = await Promise.all(
        admission.destinations.map((destination) =>
          destination.config
            ? uploadBackupDestination(
                destination.provider,
                destination.config,
                relativeKey,
                payload,
                manifest,
                options,
              )
            : Promise.resolve({
                provider: destination.provider,
                ok: false,
                error: destination.error,
              }),
        ),
      );
      await recordResults(admission, target, attemptedAt, results, manifest);
      recorded = true;
      if (results.some((result) => !result.ok)) throw backupDestinationFailure(results);
      return manifest;
    } catch (error) {
      if (!recorded && admission?.destinations.length) {
        results = admission.destinations.map((destination) => ({
          provider: destination.provider,
          ok: false,
          error:
            destination.error ?? (error instanceof Error ? error.message : "Git backup failed"),
        }));
        await recordResults(admission, target, attemptedAt, results);
      } else if (!recorded) {
        await store.updateState((state) => ({
          ...state,
          running: false,
          error: error instanceof Error ? error.message : "Git backup failed",
        }));
      }
      onFailure?.(
        admission?.config,
        results,
        error instanceof Error ? error.message : "Git backup failed",
      );
      throw error;
    }
  }

  async function poll(): Promise<void> {
    if (disposed || polling) return;
    polling = true;
    let release: (() => Promise<void>) | null = null;
    try {
      const initial = await store.loadConfig();
      const initialState = await store.loadState();
      schedulerFailureLogged = false;
      if (!initial.enabled || !initial.workspaces.length) return;
      if (initialState.nextDueAt !== null && initialState.nextDueAt > now()) return;
      release = await executionLock();
      if (!release || disposed) return;
      const config = await store.loadConfig();
      const state = await store.loadState();
      if (
        !config.enabled ||
        !getSelectedGitBackupProviders(config).length ||
        !config.workspaces.length ||
        (state.nextDueAt !== null && state.nextDueAt > now())
      )
        return;
      const cycleStarted = now();
      const failures: Array<{
        config?: GitBackupConfig;
        results: GitBackupDestinationResult[];
        message: string;
      }> = [];
      for (const target of config.workspaces) {
        // 停止只允许已开始的运行完成；每个下一个目标 admission 前重新读取权威配置。
        const fresh = await store.loadConfig();
        if (disposed || !fresh.enabled) break;
        const currentTarget = fresh.workspaces.find(
          (item) => gitBackupWorkspaceKey(item) === gitBackupWorkspaceKey(target),
        );
        if (!currentTarget) continue;
        const previousFailures = failures.length;
        try {
          await backup(currentTarget, undefined, (config, results, message) => {
            failures.push({ config, results, message });
          });
        } catch (error) {
          // 仅已记录的备份失败可继续下个工作区；持久化失败必须交给周期错误处理。
          if (failures.length === previousFailures) throw error;
        }
      }
      await store.updateState((latest, current) => {
        // 周期结束时配置可能再次变化，不能把先前工作区的旧位置错误重新写回来。
        const validFailures = failures.flatMap((failure) => {
          if (!failure.config || !failure.results.length)
            return [{ message: failure.message, providers: [] as GitBackupProvider[] }];
          const results = failure.results.filter(
            (result) =>
              !result.ok &&
              getGitBackupDestinationLocation(failure.config![result.provider]) ===
                getGitBackupDestinationLocation(current[result.provider]),
          );
          return results.length
            ? [
                {
                  message: backupDestinationFailure(results).message,
                  providers: results.map((result) => result.provider),
                },
              ]
            : [];
        });
        return {
          ...latest,
          running: false,
          ...(validFailures.length
            ? {
                error: `${validFailures.length} workspace backup(s) failed: ${validFailures.map((failure) => failure.message).join("; ")}`,
                errorProviders: [...new Set(validFailures.flatMap((failure) => failure.providers))],
              }
            : {}),
          nextDueAt: current.enabled
            ? Math.max(now(), cycleStarted) + current.intervalMinutes * 60_000
            : null,
        };
      });
    } catch (error) {
      if (!schedulerFailureLogged) {
        // 未持有执行锁时不能写另一 owner 状态；只记录无凭据和路径的诊断。
        logger.warn(undefined, "Scheduler could not read or process backup state");
        schedulerFailureLogged = true;
      }
      if (release)
        await store
          .updateState((state) => ({
            ...state,
            running: false,
            error: error instanceof Error ? error.message : "Git backup scheduler failed",
          }))
          .catch(() => undefined);
    } finally {
      await release?.();
      polling = false;
    }
  }

  const timer = setInterval(() => {
    void poll();
  }, options.schedulerPollMs ?? 5_000);
  timer.unref();
  void poll();
  return {
    configure(partial, workspace, configureOptions) {
      return store.configure(partial, workspace, now(), configureOptions);
    },
    removeWorkspace(target) {
      return store.removeWorkspace(target);
    },
    getConfig() {
      return store.loadConfig();
    },
    async getStatus() {
      const state = await store.loadState();
      if (state.running) {
        const release = await executionLock();
        if (release) {
          try {
            // 崩溃后的持久化 running 只能在确认没有活跃执行锁时清理，不能靠超时猜测。
            await store.updateState((current) =>
              current.running
                ? { ...current, running: false, error: "Previous Git backup was interrupted" }
                : current,
            );
          } finally {
            await release();
          }
        }
      }
      return store.getStatus();
    },
    async startBackup(workspacePath, workspaceIdentity, provider) {
      if (disposed) throw new Error("Git backup service is disposed");
      const target = validateBackupTarget({ workspacePath, workspaceIdentity });
      const release = await executionLock();
      if (!release) throw new Error("A Git backup is already running for this profile");
      try {
        return await backup(target, provider);
      } finally {
        await release();
      }
    },
    stopBackup() {
      return store.configure({ enabled: false }, undefined, now());
    },
    async testConnection(config, provider = "oss") {
      try {
        const resolved = await store.resolveDestination(provider, config);
        return provider === "minio"
          ? await testMinioConnection(resolved as GitBackupMinioConfig, options)
          : await testOssConnection(resolved as GitBackupOssConfig, options);
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : "Backup connection failed",
        };
      }
    },
    exportPrivateKey() {
      return readPrivateKey(dataDir);
    },
    async getPublicKey() {
      return (await ensureKeyPair(dataDir)).publicKey;
    },
    hasCompletedOnboarding() {
      return store.hasCompletedOnboarding();
    },
    markOnboardingComplete() {
      return store.markOnboardingComplete();
    },
    dispose() {
      disposed = true;
      clearInterval(timer);
    },
  };
}
