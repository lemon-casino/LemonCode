import { ServiceChannels } from "@lcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface GitBackupOssConfig {
  accessKeyId: string;
  accessKeySecret: string;
  bucket: string;
  region: string;
  pathPrefix?: string;
}

export type GitBackupProvider = "oss" | "minio";

export interface GitBackupMinioConfig {
  endpoint: string;
  accessKeyId: string;
  accessKeySecret: string;
  bucket: string;
  region: string;
  pathPrefix?: string;
}

export type GitBackupDestinationConfig = GitBackupOssConfig | GitBackupMinioConfig;

export interface GitBackupDestinationSelection {
  oss: boolean;
  minio: boolean;
}

export interface GitBackupWorkspaceTarget {
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface GitBackupConfig {
  enabled: boolean;
  intervalMinutes: number;
  oss: GitBackupOssConfig | null;
  minio?: GitBackupMinioConfig | null;
  destinationEnabled?: GitBackupDestinationSelection;
  workspaces: GitBackupWorkspaceTarget[];
}

export interface GitBackupManifestEntry {
  path: string;
  size: number;
  sha256: string;
}

export interface GitBackupManifest {
  version: "repo_backup_manifest/v1";
  workspacePath: string;
  workspaceIdentity?: string;
  createdAt: string;
  totalFiles: number;
  totalSize: number;
  entries: GitBackupManifestEntry[];
}

export interface GitBackupDestinationStatus {
  enabled: boolean;
  configured: boolean;
  lastAttemptAt: string | null;
  lastBackupAt: string | null;
  lastBackupFiles: number;
  lastBackupSize: number;
  lastWorkspacePath: string | null;
  error: string | null;
}

export interface GitBackupDestinationResult {
  provider: GitBackupProvider;
  ok: boolean;
  error?: string;
}

export type GitBackupConfigUpdate = Partial<
  Pick<GitBackupConfig, "enabled" | "intervalMinutes" | "oss" | "minio">
> & { destinationEnabled?: Partial<GitBackupDestinationSelection> };

export interface GitBackupStatus {
  enabled: boolean;
  configured: boolean;
  lastBackupAt: string | null;
  lastBackupFiles: number;
  lastBackupSize: number;
  lastWorkspacePath: string | null;
  nextBackupAt: string | null;
  running: boolean;
  error: string | null;
  destinations?: Partial<Record<GitBackupProvider, GitBackupDestinationStatus>>;
  lastBackupProviders?: GitBackupProvider[];
  errorProviders?: GitBackupProvider[];
}

export interface IGitBackupService {
  configure(
    config: GitBackupConfigUpdate,
    workspace?: GitBackupWorkspaceTarget,
    options?: { completeOnboarding?: boolean },
  ): Promise<void>;
  removeWorkspace(workspace: GitBackupWorkspaceTarget): Promise<void>;
  getConfig(): Promise<GitBackupConfig>;
  getStatus(): Promise<GitBackupStatus>;
  startBackup(
    workspacePath: string,
    workspaceIdentity?: string,
    provider?: GitBackupProvider,
  ): Promise<GitBackupManifest>;
  stopBackup(): Promise<void>;
  testConnection(
    config: GitBackupDestinationConfig,
    provider?: GitBackupProvider,
  ): Promise<{ ok: boolean; error?: string }>;
  exportPrivateKey(): Promise<string>;
  getPublicKey(): Promise<string>;
  hasCompletedOnboarding(): Promise<boolean>;
  markOnboardingComplete(): Promise<void>;
}

export const IGitBackupService = createServiceDescriptor<IGitBackupService>(
  ServiceChannels.GitBackup,
);

export function normalizeGitBackupOssConfig(
  input: GitBackupOssConfig,
  allowEmptySecret = false,
): GitBackupOssConfig {
  if (!input || typeof input !== "object") throw new Error("Invalid OSS configuration");
  const text = (value: unknown, name: string): string => {
    if (typeof value !== "string") throw new Error(`Invalid OSS ${name}`);
    return value.trim();
  };
  const accessKeyId = text(input.accessKeyId, "AccessKey ID");
  const accessKeySecret = text(input.accessKeySecret, "AccessKey Secret");
  const bucket = text(input.bucket, "bucket");
  const region = text(input.region, "region").replace(/^oss-/, "");
  const pathPrefix = text(input.pathPrefix ?? "", "path prefix");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(accessKeyId)) throw new Error("Invalid OSS AccessKey ID");
  if (
    (!accessKeySecret && !allowEmptySecret) ||
    !/^[A-Za-z0-9_+\x2f=.-]{0,256}$/.test(accessKeySecret)
  ) {
    throw new Error("Invalid OSS AccessKey Secret");
  }
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error("Invalid OSS bucket name");
  if (!/^[a-z]{2,8}-[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(region)) {
    throw new Error("Invalid OSS region; use cn-hangzhou or oss-cn-hangzhou");
  }
  if (
    pathPrefix.length > 512 ||
    (pathPrefix &&
      !pathPrefix
        .split("/")
        .every(
          (part) => /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(part) && part !== "." && part !== "..",
        ))
  ) {
    throw new Error("Invalid OSS path prefix");
  }
  return {
    accessKeyId,
    accessKeySecret,
    bucket,
    region: `oss-${region}`,
    ...(pathPrefix ? { pathPrefix } : {}),
  };
}

export function normalizeGitBackupMinioConfig(
  input: GitBackupMinioConfig,
  allowEmptySecret = false,
): GitBackupMinioConfig {
  if (!input || typeof input !== "object") throw new Error("Invalid MinIO configuration");
  const text = (value: unknown, name: string): string => {
    if (typeof value !== "string") throw new Error(`Invalid MinIO ${name}`);
    return value.trim();
  };
  const endpoint = text(input.endpoint, "endpoint");
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("MinIO endpoint must be an HTTP or HTTPS S3 API origin");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    /[\s\\]/.test(endpoint)
  )
    throw new Error("MinIO endpoint must be an HTTP or HTTPS S3 API origin without a path");
  const accessKeyId = text(input.accessKeyId, "AccessKey ID");
  const accessKeySecret = text(input.accessKeySecret, "AccessKey Secret");
  const bucket = text(input.bucket, "bucket");
  const region = text(input.region || "us-east-1", "region");
  const pathPrefix = text(input.pathPrefix ?? "", "path prefix");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(accessKeyId)) throw new Error("Invalid MinIO AccessKey ID");
  if (
    (!accessKeySecret && !allowEmptySecret) ||
    accessKeySecret.length > 256 ||
    [...accessKeySecret].some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)
  )
    throw new Error("Invalid MinIO AccessKey Secret");
  if (
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) ||
    bucket.includes("..") ||
    bucket.includes(".-") ||
    bucket.includes("-.") ||
    /^\d+\.\d+\.\d+\.\d+$/.test(bucket)
  )
    throw new Error("Invalid MinIO bucket name");
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/.test(region)) throw new Error("Invalid MinIO region");
  if (
    pathPrefix.length > 512 ||
    (pathPrefix &&
      !pathPrefix
        .split("/")
        .every(
          (part) => /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(part) && part !== "." && part !== "..",
        ))
  )
    throw new Error("Invalid MinIO path prefix");
  return {
    endpoint: url.origin,
    accessKeyId,
    accessKeySecret,
    bucket,
    region,
    ...(pathPrefix ? { pathPrefix } : {}),
  };
}

export function getGitBackupDestinationSelection(
  config: GitBackupConfig,
): GitBackupDestinationSelection {
  return config.destinationEnabled ?? { oss: Boolean(config.oss), minio: false };
}

export function getSelectedGitBackupProviders(config: GitBackupConfig): GitBackupProvider[] {
  const selection = getGitBackupDestinationSelection(config);
  return (["oss", "minio"] as const).filter((provider) => selection[provider]);
}

export function getGitBackupAggregateProviders(
  status: Pick<
    GitBackupStatus,
    "lastBackupAt" | "error" | "lastBackupProviders" | "errorProviders"
  > & {
    destinations?: Partial<
      Record<GitBackupProvider, Pick<GitBackupDestinationStatus, "lastBackupAt" | "error">>
    >;
  },
  kind: "success" | "error",
): GitBackupProvider[] {
  if (!(kind === "success" ? status.lastBackupAt : status.error)) return [];
  const recorded = kind === "success" ? status.lastBackupProviders : status.errorProviders;
  if (recorded) return recorded;
  // 旧 v2 没有归属字段，按目的地记录推断；证据不足时不能把旧结果留给替换后的地址。
  const inferred = (["oss", "minio"] as const).filter((provider) => {
    const destination = status.destinations?.[provider];
    return (
      destination &&
      (kind === "success"
        ? Boolean(status.lastBackupAt && destination.lastBackupAt === status.lastBackupAt)
        : Boolean(destination.error))
    );
  });
  return inferred.length ? inferred : ["oss", "minio"];
}

export function getGitBackupDestinationLocation(
  config: GitBackupDestinationConfig | null | undefined,
): string {
  if (!config) return "";
  return JSON.stringify([
    "endpoint" in config ? config.endpoint : "oss",
    config.accessKeyId,
    config.bucket,
    config.region,
    config.pathPrefix ?? "",
  ]);
}

export function gitBackupWorkspaceKey(target: GitBackupWorkspaceTarget): string {
  return target.workspaceIdentity?.trim() || target.workspacePath;
}
