import type { GitBackupOssConfig } from "@lcode/services";

export interface GitBackupLegacyStorage {
  getItem(key: string): string | null;
  removeItem(key: string): void;
}

export function readLegacyGitBackupConfig(
  storage: GitBackupLegacyStorage | null,
): GitBackupOssConfig | null {
  try {
    const raw = storage?.getItem("git-backup-config");
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || !("oss" in value)) return null;
    const oss = value.oss;
    if (!oss || typeof oss !== "object") return null;
    const fields = ["accessKeyId", "accessKeySecret", "bucket", "region"] as const;
    const config = oss as Record<string, unknown>;
    if (!fields.every((field) => typeof config[field] === "string")) return null;
    return {
      accessKeyId: (config.accessKeyId as string).trim(),
      accessKeySecret: (config.accessKeySecret as string).trim(),
      bucket: (config.bucket as string).trim(),
      region: (config.region as string).trim(),
      pathPrefix: typeof config.pathPrefix === "string" ? config.pathPrefix.trim() : "",
    };
  } catch {
    return null;
  }
}

export function hasLegacyGitBackupOnboarding(storage: GitBackupLegacyStorage | null): boolean {
  try {
    return storage?.getItem("git-backup-onboarding-done") === "1";
  } catch {
    return false;
  }
}

export function clearLegacyGitBackupConfig(storage: GitBackupLegacyStorage | null): void {
  // 旧凭据只有在 Host 保存成功后才能删除；读取草稿不代表用户已同意启用。
  try {
    storage?.removeItem("git-backup-config");
  } catch {
    // 浏览器禁止删除时保留旧数据，不把已成功的 Host 保存误报为失败。
  }
}

export function clearLegacyGitBackupOnboarding(storage: GitBackupLegacyStorage | null): void {
  try {
    storage?.removeItem("git-backup-onboarding-done");
  } catch {
    // Host 已持久化完成标记；浏览器清理失败不能让成功的引导再次要求提交。
  }
}

export function getGitBackupLegacyStorage(): GitBackupLegacyStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
