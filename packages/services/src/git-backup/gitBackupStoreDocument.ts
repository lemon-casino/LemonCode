import { createHash, randomUUID } from "node:crypto";
import type { ICredentialService } from "../credential/credential.js";
import { access, readFile } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { atomicWritePrivateTextFile, withFileLock } from "@lcode/shared/node";
import {
  getGitBackupDestinationSelection,
  normalizeGitBackupOssConfig,
  normalizeGitBackupMinioConfig,
  type GitBackupConfig,
  type GitBackupDestinationConfig,
  type GitBackupDestinationStatus,
  type GitBackupProvider,
  type GitBackupWorkspaceTarget,
  type GitBackupOssConfig,
  type GitBackupMinioConfig,
} from "./gitBackup.js";

export type GitBackupStoredDestinationState = Omit<
  GitBackupDestinationStatus,
  "enabled" | "configured"
>;
export const EMPTY_BACKUP_DESTINATION_STATE: GitBackupStoredDestinationState = {
  lastAttemptAt: null,
  lastBackupAt: null,
  lastBackupFiles: 0,
  lastBackupSize: 0,
  lastWorkspacePath: null,
  error: null,
};
export interface GitBackupStoredState {
  nextDueAt: number | null;
  lastBackupAt: string | null;
  lastBackupFiles: number;
  lastBackupSize: number;
  lastWorkspacePath: string | null;
  running: boolean;
  error: string | null;
  destinations?: Partial<Record<GitBackupProvider, GitBackupStoredDestinationState>>;
  lastBackupProviders?: GitBackupProvider[];
  errorProviders?: GitBackupProvider[];
}
export const EMPTY_BACKUP_STATE: GitBackupStoredState = {
  nextDueAt: null,
  lastBackupAt: null,
  lastBackupFiles: 0,
  lastBackupSize: 0,
  lastWorkspacePath: null,
  running: false,
  error: null,
};
export interface BackupDocument {
  config: GitBackupConfig;
  state: GitBackupStoredState;
  credentialReferences: Record<GitBackupProvider, string | null>;
  onboardingComplete: boolean;
}
export interface BackupStoreOptions {
  write?: (path: string, content: string) => Promise<void>;
}
export const BACKUP_PROVIDERS = ["oss", "minio"] as const;
export function validateProvider(provider: GitBackupProvider) {
  if (!BACKUP_PROVIDERS.includes(provider)) throw new Error("Invalid Git backup provider");
}
export function normalizeDestination(
  provider: GitBackupProvider,
  input: GitBackupDestinationConfig,
) {
  validateProvider(provider);
  return provider === "oss"
    ? normalizeGitBackupOssConfig(input as GitBackupOssConfig, true)
    : normalizeGitBackupMinioConfig(input as GitBackupMinioConfig, true);
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
export function validateSelection(value: unknown, complete = false) {
  if (
    !isRecord(value) ||
    Object.entries(value).some(
      ([key, flag]) =>
        !BACKUP_PROVIDERS.includes(key as GitBackupProvider) || typeof flag !== "boolean",
    ) ||
    (complete && BACKUP_PROVIDERS.some((provider) => typeof value[provider] !== "boolean"))
  ) {
    throw new Error("Invalid Git backup destination selection");
  }
}
export function validateBackupTarget(target: GitBackupWorkspaceTarget): GitBackupWorkspaceTarget {
  if (
    !target ||
    typeof target.workspacePath !== "string" ||
    !isAbsolute(target.workspacePath) ||
    target.workspacePath.includes("\0")
  )
    throw new Error("A valid absolute workspace path is required");
  if (
    target.workspaceIdentity !== undefined &&
    (typeof target.workspaceIdentity !== "string" || target.workspaceIdentity.includes("\0"))
  )
    throw new Error("Invalid workspace identity");
  return {
    workspacePath: target.workspacePath,
    ...(target.workspaceIdentity?.trim()
      ? { workspaceIdentity: target.workspaceIdentity.trim() }
      : {}),
  };
}
async function readJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Git backup persistence is unreadable or corrupt; refusing to overwrite", {
      cause: error,
    });
  }
}
function parseConfig(value: unknown): GitBackupConfig {
  if (value === undefined)
    return {
      enabled: false,
      intervalMinutes: 60,
      oss: null,
      minio: null,
      destinationEnabled: { oss: false, minio: false },
      workspaces: [],
    };
  if (!isRecord(value)) throw new Error("Invalid Git backup configuration");
  const raw = value as unknown as GitBackupConfig;
  if (
    typeof raw.enabled !== "boolean" ||
    !Number.isInteger(raw.intervalMinutes) ||
    raw.intervalMinutes < 5 ||
    raw.intervalMinutes > 1440
  )
    throw new Error("Invalid Git backup configuration");
  if (raw.workspaces !== undefined && !Array.isArray(raw.workspaces))
    throw new Error("Invalid backup workspace list");
  if (raw.destinationEnabled !== undefined) validateSelection(raw.destinationEnabled, true);
  return {
    enabled: raw.enabled,
    intervalMinutes: raw.intervalMinutes,
    oss: raw.oss ? normalizeGitBackupOssConfig({ ...raw.oss, accessKeySecret: "" }, true) : null,
    minio: raw.minio
      ? normalizeGitBackupMinioConfig({ ...raw.minio, accessKeySecret: "" }, true)
      : null,
    destinationEnabled: getGitBackupDestinationSelection(raw),
    workspaces: (raw.workspaces ?? []).map(validateBackupTarget),
  };
}
function parseDestinationState(value: unknown): GitBackupStoredDestinationState {
  if (
    !isRecord(value) ||
    !["lastAttemptAt", "lastBackupAt", "lastWorkspacePath", "error"].every(
      (key) => value[key] === null || typeof value[key] === "string",
    ) ||
    !["lastBackupFiles", "lastBackupSize"].every(
      (key) => typeof value[key] === "number" && Number.isFinite(value[key]) && value[key] >= 0,
    )
  )
    throw new Error("Invalid Git backup destination state");
  return Object.fromEntries(
    Object.keys(EMPTY_BACKUP_DESTINATION_STATE).map((key) => [key, value[key]]),
  ) as unknown as GitBackupStoredDestinationState;
}
export function parseState(value: unknown): GitBackupStoredState {
  if (value === undefined) return { ...EMPTY_BACKUP_STATE };
  if (!isRecord(value)) throw new Error("Invalid Git backup state");
  const state = value as unknown as GitBackupStoredState;
  if (
    typeof state.running !== "boolean" ||
    (state.nextDueAt !== null && (!Number.isFinite(state.nextDueAt) || state.nextDueAt < 0)) ||
    typeof state.lastBackupFiles !== "number" ||
    typeof state.lastBackupSize !== "number" ||
    (state.lastBackupAt !== null && typeof state.lastBackupAt !== "string") ||
    (state.lastWorkspacePath !== null && typeof state.lastWorkspacePath !== "string") ||
    (state.error !== null && typeof state.error !== "string")
  )
    throw new Error("Invalid Git backup state");
  for (const providers of [state.lastBackupProviders, state.errorProviders]) {
    if (
      providers !== undefined &&
      (!Array.isArray(providers) ||
        new Set(providers).size !== providers.length ||
        providers.some((provider) => !BACKUP_PROVIDERS.includes(provider)))
    )
      throw new Error("Invalid Git backup result providers");
  }
  if (state.destinations === undefined) return state;
  if (
    !isRecord(state.destinations) ||
    Object.keys(state.destinations).some(
      (key) => !BACKUP_PROVIDERS.includes(key as GitBackupProvider),
    )
  )
    throw new Error("Invalid Git backup destination state");
  const destinations: GitBackupStoredState["destinations"] = {};
  for (const provider of BACKUP_PROVIDERS) {
    if (state.destinations[provider] !== undefined)
      destinations[provider] = parseDestinationState(state.destinations[provider]);
  }
  return { ...state, destinations };
}
function migrateState(config: GitBackupConfig, state: GitBackupStoredState): GitBackupStoredState {
  if (!config.oss) return state;
  return {
    ...state,
    ...(state.lastBackupAt ? { lastBackupProviders: ["oss"] as GitBackupProvider[] } : {}),
    ...(state.error ? { errorProviders: ["oss"] as GitBackupProvider[] } : {}),
    destinations: {
      ...state.destinations,
      oss: state.destinations?.oss ?? {
        lastAttemptAt: state.lastBackupAt,
        lastBackupAt: state.lastBackupAt,
        lastBackupFiles: state.lastBackupFiles,
        lastBackupSize: state.lastBackupSize,
        lastWorkspacePath: state.lastWorkspacePath,
        error: state.error,
      },
    },
  };
}
export function createBackupDocumentAccess(
  dataDir: string,
  options: BackupStoreOptions,
  credentials?: Pick<ICredentialService, "load" | "save" | "delete">,
) {
  const configPath = join(dataDir, "git-backup-config.json");
  const write = options.write ?? atomicWritePrivateTextFile;
  const save = (document: BackupDocument) =>
    write(
      configPath,
      `${JSON.stringify(
        {
          ...document.config,
          _backup: {
            version: 2,
            state: document.state,
            credentialReferences: document.credentialReferences,
            onboardingComplete: document.onboardingComplete,
          },
        },
        null,
        2,
      )}\n`,
    );
  async function readDocument(): Promise<BackupDocument> {
    const value = await readJson(configPath);
    const config = parseConfig(value);
    const metadata = isRecord(value) ? value._backup : undefined;
    if (metadata !== undefined) {
      if (!isRecord(metadata) || typeof metadata.onboardingComplete !== "boolean")
        throw new Error("Invalid Git backup metadata");
      const state = parseState(metadata.state);
      if (metadata.version === 2) {
        const references = metadata.credentialReferences;
        if (
          !isRecord(references) ||
          BACKUP_PROVIDERS.some(
            (provider) => references[provider] !== null && typeof references[provider] !== "string",
          ) ||
          !isRecord(value) ||
          value.destinationEnabled === undefined
        )
          throw new Error("Invalid Git backup metadata");
        return {
          config,
          state,
          credentialReferences: references as Record<GitBackupProvider, string | null>,
          onboardingComplete: metadata.onboardingComplete,
        };
      }
      if (
        metadata.version !== 1 ||
        (metadata.credentialReference !== null && typeof metadata.credentialReference !== "string")
      )
        throw new Error("Invalid Git backup metadata");
      // v1 引用已经固定身份，迁移不能按新 profile 路径重新计算或归入 MinIO。
      const document: BackupDocument = {
        config,
        state: migrateState(config, state),
        credentialReferences: { oss: metadata.credentialReference as string | null, minio: null },
        onboardingComplete: metadata.onboardingComplete,
      };
      await save(document);
      return document;
    }
    // 旧分文件只导入一次；首次生成文档后忽略旧文件，避免覆盖已接受状态。
    const state = parseState(await readJson(join(dataDir, "git-backup-state.json")));
    let onboardingComplete = false;
    try {
      await access(join(dataDir, "git-backup-onboarding-done"));
      onboardingComplete = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const document: BackupDocument = {
      config,
      state: migrateState(config, state),
      onboardingComplete,
      credentialReferences: {
        oss: config.oss
          ? `git-backup:${createHash("sha256").update(dataDir).digest("hex").slice(0, 24)}:${config.oss.accessKeyId}`
          : null,
        minio: null,
      },
    };
    const legacyOss = isRecord(value) && isRecord(value.oss) ? value.oss : undefined;
    const secret = legacyOss?.accessKeySecret;
    let stagedReference: string | undefined;
    try {
      if (typeof secret === "string" && secret.trim() && config.oss) {
        if (!credentials) throw new Error("Backup credential service is unavailable for migration");
        const normalized = normalizeGitBackupOssConfig({ ...config.oss, accessKeySecret: secret });
        // 旧 JSON 可能是唯一密钥来源；先保存新不可变引用，提交失败保留原文件和已有凭据。
        stagedReference = `git-backup:oss:${randomUUID()}:${config.oss.accessKeyId}`;
        try {
          await credentials.save(stagedReference, normalized.accessKeySecret);
        } catch {
          throw new Error("OSS credentials could not be saved during migration");
        }
        document.credentialReferences.oss = stagedReference;
      }
      await save(document);
      return document;
    } catch (error) {
      if (stagedReference) await credentials!.delete(stagedReference).catch(() => undefined);
      throw error;
    }
  }
  return { configPath, save, readDocument, read: () => withFileLock(configPath, readDocument) };
}
