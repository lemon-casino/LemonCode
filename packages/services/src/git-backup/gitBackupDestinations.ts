import type {
  GitBackupDestinationConfig,
  GitBackupManifest,
  GitBackupMinioConfig,
  GitBackupOssConfig,
  GitBackupProvider,
  GitBackupDestinationResult,
} from "./gitBackup.js";
import { uploadToOss, type OssRequestOptions } from "./gitBackupOssClient.js";
import { uploadToMinio } from "./gitBackupMinioClient.js";

export async function uploadBackupDestination(
  provider: GitBackupProvider,
  config: GitBackupDestinationConfig,
  relativeKey: string,
  payload: { encryptedData: Buffer; encryptedKey: Buffer; iv: Buffer },
  manifest: GitBackupManifest,
  options: OssRequestOptions,
): Promise<GitBackupDestinationResult> {
  try {
    const baseName = `${config.pathPrefix ? `${config.pathPrefix}/` : ""}${relativeKey}`;
    const upload = (name: string, data: Buffer, contentType: string) =>
      provider === "oss"
        ? uploadToOss(
            config as GitBackupOssConfig,
            `${baseName}/${name}`,
            data,
            contentType,
            options,
          )
        : uploadToMinio(
            config as GitBackupMinioConfig,
            `${baseName}/${name}`,
            data,
            contentType,
            options,
          );
    // 任一请求拒绝不能提前释放执行锁；每个目的地先等待所有数据上传结束再提交清单。
    const results = await Promise.allSettled([
      upload("data.enc", payload.encryptedData, "application/octet-stream"),
      upload("key.enc", payload.encryptedKey, "application/octet-stream"),
      upload("iv.bin", payload.iv, "application/octet-stream"),
    ]);
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    if (results.some((result) => result.status === "fulfilled" && !result.value.ok))
      throw new Error(`${provider} upload failed`);
    await upload(
      "manifest.json",
      Buffer.from(JSON.stringify(manifest, null, 2)),
      "application/json",
    );
    return { provider, ok: true };
  } catch (error) {
    return {
      provider,
      ok: false,
      error: error instanceof Error ? error.message : "Git backup upload failed",
    };
  }
}

export function backupDestinationFailure(results: GitBackupDestinationResult[]): Error {
  const failed = results.filter((result) => !result.ok);
  return Object.assign(
    new Error(
      `Git backup destination(s) failed: ${failed.map((result) => `${result.provider}: ${result.error}`).join("; ")}`,
    ),
    { code: "GIT_BACKUP_DESTINATION_FAILED", details: { destinations: results } },
  );
}
