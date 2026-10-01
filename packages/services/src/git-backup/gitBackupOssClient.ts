import { createHmac } from "node:crypto";
import { normalizeGitBackupOssConfig, type GitBackupOssConfig } from "./gitBackup.js";

export interface OssRequestOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  now?: () => number;
}

export interface OssUploadResult {
  ok: boolean;
  statusCode: number;
  objectKey: string;
  error?: string;
}

function requestParts(
  config: GitBackupOssConfig,
  objectKey: string,
  method: string,
  contentType: string,
  now: number,
) {
  const normalized = normalizeGitBackupOssConfig(config);
  if (
    objectKey.startsWith("/") ||
    objectKey.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    if (objectKey) throw new Error("Invalid OSS object key");
  }
  const encodedKey = objectKey.split("/").map(encodeURIComponent).join("/");
  const date = new Date(now).toUTCString();
  const resource = `/${normalized.bucket}/${objectKey}`;
  const signature = createHmac("sha1", normalized.accessKeySecret)
    .update(`${method}\n\n${contentType}\n${date}\n${resource}`)
    .digest("base64");
  // Node fetch 会移除自定义 Host，必须把 bucket 放进 URL，不能只依赖 header。
  return {
    url: `https://${normalized.bucket}.${normalized.region}.aliyuncs.com/${encodedKey}`,
    headers: {
      Date: date,
      Authorization: `OSS ${normalized.accessKeyId}:${signature}`,
      ...(contentType ? { "Content-Type": contentType } : {}),
    },
  };
}

async function request(
  config: GitBackupOssConfig,
  key: string,
  method: "PUT" | "HEAD",
  data: Buffer | undefined,
  contentType: string,
  options: OssRequestOptions,
) {
  const parts = requestParts(config, key, method, contentType, (options.now ?? Date.now)());
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("OSS request timed out")),
    options.timeoutMs ?? 60_000,
  );
  let statusCode = 0;
  try {
    const response = await (options.fetch ?? globalThis.fetch)(parts.url, {
      method,
      headers: parts.headers,
      body: data,
      signal: controller.signal,
      redirect: "error",
    });
    try {
      // 注入的传输即使在超时后返回，也不能把该请求报告成功。
      controller.signal.throwIfAborted();
      statusCode = response.status;
    } finally {
      await response.body?.cancel();
    }
    controller.signal.throwIfAborted();
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`OSS ${method} request timed out`);
    if (error instanceof Error && error.name === "AbortError")
      throw new Error(`OSS ${method} request aborted`);
    // 网络异常可能包含签名 header 或凭据，不能透传到多目的地状态、RPC 和页面。
    throw new Error(`OSS ${method} request failed`);
  } finally {
    clearTimeout(timeout);
  }
  if (statusCode < 200 || statusCode >= 300)
    throw new Error(`OSS ${method} failed (HTTP ${statusCode})`);
  return statusCode;
}

export async function uploadToOss(
  config: GitBackupOssConfig,
  objectKey: string,
  data: Buffer,
  contentType = "application/octet-stream",
  options: OssRequestOptions = {},
): Promise<OssUploadResult> {
  const statusCode = await request(config, objectKey, "PUT", data, contentType, options);
  return { ok: true, statusCode, objectKey };
}

export async function testOssConnection(
  config: GitBackupOssConfig,
  options: OssRequestOptions = {},
): Promise<{ ok: boolean; error?: string }> {
  try {
    await request(config, "", "HEAD", undefined, "", options);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "OSS connection failed" };
  }
}
