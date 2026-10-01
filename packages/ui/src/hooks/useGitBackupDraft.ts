import {
  getGitBackupDestinationSelection,
  normalizeGitBackupOssConfig,
  normalizeGitBackupMinioConfig,
  type GitBackupConfig,
  type GitBackupConfigUpdate,
  type GitBackupMinioConfig,
  type GitBackupOssConfig,
  type GitBackupProvider,
} from "@lcode/services";

export interface GitBackupDraft {
  oss: GitBackupOssConfig;
  minio: GitBackupMinioConfig;
  intervalMinutes: string;
}

export interface GitBackupValidationError {
  id: string;
  detail?: string;
}

export function createGitBackupDraft(config: GitBackupConfig): GitBackupDraft {
  return {
    oss: {
      accessKeyId: "",
      bucket: "",
      region: "",
      pathPrefix: "",
      ...config.oss,
      // 服务读模型不含 Secret；不能把已保存凭据复制回可见草稿。
      accessKeySecret: "",
    },
    minio: {
      endpoint: "",
      accessKeyId: "",
      bucket: "",
      region: "us-east-1",
      pathPrefix: "",
      ...config.minio,
      accessKeySecret: "",
    },
    intervalMinutes: String(config.intervalMinutes),
  };
}

export function hasStoredGitBackupSecret(
  input: GitBackupOssConfig,
  saved: GitBackupOssConfig | null,
): boolean {
  if (!saved || input.accessKeyId.trim() !== saved.accessKeyId.trim()) return false;
  // MinIO 更换 origin 后必须重新输入密钥，不能把旧服务器凭据发送到新地址。
  if ("endpoint" in input || "endpoint" in saved) {
    if (!("endpoint" in input) || !("endpoint" in saved)) return false;
    try {
      return new URL(String(input.endpoint)).origin === new URL(String(saved.endpoint)).origin;
    } catch {
      return false;
    }
  }
  return true;
}

export function validateGitBackupOss(
  oss: GitBackupOssConfig,
  savedOss: GitBackupOssConfig | null,
): { oss: GitBackupOssConfig; error: null } | { oss: null; error: GitBackupValidationError } {
  if (!oss.accessKeySecret.trim() && !hasStoredGitBackupSecret(oss, savedOss)) {
    return { oss: null, error: { id: "settings.gitBackup.validation.secretRequired" } };
  }
  try {
    return {
      oss: normalizeGitBackupOssConfig(oss, hasStoredGitBackupSecret(oss, savedOss)),
      error: null,
    };
  } catch (error) {
    return {
      oss: null,
      error: { id: "settings.gitBackup.validation.oss", detail: message(error) },
    };
  }
}

export function validateGitBackupMinio(
  minio: GitBackupMinioConfig,
  saved: GitBackupMinioConfig | null,
): { minio: GitBackupMinioConfig; error: null } | { minio: null; error: GitBackupValidationError } {
  if (!minio.accessKeySecret.trim() && !hasStoredGitBackupSecret(minio, saved)) {
    return { minio: null, error: { id: "settings.gitBackup.validation.secretRequired" } };
  }
  try {
    return {
      minio: normalizeGitBackupMinioConfig(minio, hasStoredGitBackupSecret(minio, saved)),
      error: null,
    };
  } catch (error) {
    return {
      minio: null,
      error: { id: "settings.gitBackup.validation.minio", detail: message(error) },
    };
  }
}

export function validateGitBackupDraft(
  draft: Pick<GitBackupDraft, "oss" | "intervalMinutes">,
  savedOss: GitBackupOssConfig | null,
):
  | { config: { oss: GitBackupOssConfig; intervalMinutes: number }; error: null }
  | { config: null; error: GitBackupValidationError } {
  const error = validateInterval(draft.intervalMinutes);
  if (error) return { config: null, error };
  const result = validateGitBackupOss(draft.oss, savedOss);
  return result.error
    ? { config: null, error: result.error }
    : { config: { oss: result.oss, intervalMinutes: Number(draft.intervalMinutes) }, error: null };
}

export function createGitBackupSavePatch(
  draft: GitBackupDraft,
  config: GitBackupConfig,
  provider: GitBackupProvider,
):
  | { config: GitBackupConfigUpdate; error: null }
  | { config: null; error: GitBackupValidationError } {
  const error = validateInterval(draft.intervalMinutes);
  if (error) return { config: null, error };
  const result =
    provider === "oss"
      ? validateGitBackupOss(draft.oss, config.oss)
      : validateGitBackupMinio(draft.minio, config.minio ?? null);
  if (result.error) return { config: null, error: result.error };
  // 旧客户端保存 OSS 会默认选择 OSS；新 UI 必须明确保留选择，保存不代表启用。
  return {
    config: {
      ...("oss" in result ? { oss: result.oss } : { minio: result.minio }),
      intervalMinutes: Number(draft.intervalMinutes),
      destinationEnabled: getGitBackupDestinationSelection(config),
    },
    error: null,
  };
}

export function acceptGitBackupDraftSave(
  draft: GitBackupDraft,
  config: GitBackupConfig,
  provider: GitBackupProvider,
): GitBackupDraft {
  const saved = createGitBackupDraft(config);
  return provider === "oss"
    ? { ...draft, oss: saved.oss, intervalMinutes: saved.intervalMinutes }
    : { ...draft, minio: saved.minio, intervalMinutes: saved.intervalMinutes };
}

export function isGitBackupDraftDirty(
  draft: GitBackupDraft,
  config: GitBackupConfig,
  provider: GitBackupProvider = "oss",
): boolean {
  const saved = createGitBackupDraft(config);
  const fields = Object.keys(saved[provider]) as (keyof GitBackupOssConfig)[];
  return (
    draft.intervalMinutes !== saved.intervalMinutes ||
    fields.some((field) => (draft[provider][field] ?? "") !== (saved[provider][field] ?? ""))
  );
}

function validateInterval(value: string): GitBackupValidationError | null {
  return /^\d+$/.test(value) && Number(value) >= 5 && Number(value) <= 1440
    ? null
    : { id: "settings.gitBackup.validation.interval" };
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
