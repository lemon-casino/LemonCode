import { createHash } from "node:crypto";
import { AwsV4Signer } from "aws4fetch";
import { normalizeGitBackupMinioConfig, type GitBackupMinioConfig } from "./gitBackup.js";
import type { OssRequestOptions, OssUploadResult } from "./gitBackupOssClient.js";

function encodeObjectKey(objectKey: string, method: "PUT" | "HEAD"): string {
  if (method === "HEAD" && objectKey === "") return "";
  if (
    !objectKey ||
    Array.from(objectKey).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
    objectKey.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("Invalid MinIO object key");
  }
  try {
    // S3 签名和实际 URI 必须采用相同的 RFC 3986 分段编码，不能把字面量 %2F 当成分隔符。
    return objectKey
      .split("/")
      .map((part) =>
        encodeURIComponent(part).replace(
          /[!'()*]/g,
          (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
        ),
      )
      .join("/");
  } catch {
    throw new Error("Invalid MinIO object key");
  }
}

async function request(
  config: GitBackupMinioConfig,
  objectKey: string,
  method: "PUT" | "HEAD",
  data: Buffer | undefined,
  contentType: string,
  options: OssRequestOptions,
): Promise<number> {
  const normalized = normalizeGitBackupMinioConfig(config);
  const encodedKey = encodeObjectKey(objectKey, method);
  const url = `${normalized.endpoint}/${normalized.bucket}${encodedKey ? `/${encodedKey}` : ""}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 60_000);
  let statusCode = 0;
  try {
    const signer = new AwsV4Signer({
      url,
      method,
      accessKeyId: normalized.accessKeyId,
      secretAccessKey: normalized.accessKeySecret,
      service: "s3",
      region: normalized.region,
      datetime: new Date((options.now ?? Date.now)()).toISOString().replace(/[:-]|\.\d{3}/g, ""),
      headers: {
        // 签名器默认使用 UNSIGNED-PAYLOAD；显式哈希确保 HTTP 和 HTTPS 都签署实际上传字节。
        "X-Amz-Content-Sha256": createHash("sha256")
          .update(data ?? "")
          .digest("hex"),
        ...(contentType ? { "Content-Type": contentType } : {}),
      },
    });
    const signed = await signer.sign();
    controller.signal.throwIfAborted();
    // 只使用签名器，不使用它的网络客户端，保留 Host 注入的代理、CA 和原始 Buffer。
    const response = await (options.fetch ?? globalThis.fetch)(signed.url.toString(), {
      method: signed.method,
      headers: signed.headers,
      body: data,
      signal: controller.signal,
      redirect: "error",
    });
    try {
      // 即使注入的传输在 abort 后返回响应，也不能把已经超时的请求报告为成功。
      controller.signal.throwIfAborted();
      statusCode = response.status;
    } finally {
      await response.body?.cancel();
    }
    controller.signal.throwIfAborted();
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`MinIO ${method} request timed out`);
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`MinIO ${method} request aborted`);
    }
    // 网络错误及其 cause 可能携带 Authorization / 凭据，不能透传到服务状态或 UI。
    throw new Error(`MinIO ${method} request failed`);
  } finally {
    clearTimeout(timeout);
  }
  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(`MinIO ${method} failed (HTTP ${statusCode})`);
  }
  return statusCode;
}

export async function uploadToMinio(
  config: GitBackupMinioConfig,
  objectKey: string,
  data: Buffer,
  contentType = "application/octet-stream",
  options: OssRequestOptions = {},
): Promise<OssUploadResult> {
  const statusCode = await request(config, objectKey, "PUT", data, contentType, options);
  return { ok: true, statusCode, objectKey };
}

export async function testMinioConnection(
  config: GitBackupMinioConfig,
  options: OssRequestOptions = {},
): Promise<{ ok: boolean; error?: string }> {
  try {
    await request(config, "", "HEAD", undefined, "", options);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "MinIO connection failed" };
  }
}
