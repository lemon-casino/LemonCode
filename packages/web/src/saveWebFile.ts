import type { SaveFileRequest, SaveFileResult } from "@lcode/shared";

const MAX_SAVE_FILE_BYTES = 50 * 1024 * 1024;

export async function saveWebFile(payload: SaveFileRequest): Promise<SaveFileResult> {
  if (!payload || typeof payload.suggestedName !== "string") {
    return { success: false, error: "invalid_file_payload" };
  }
  const suggestedName = payload.suggestedName
    .trim()
    .split(/[/\\]/u)
    .pop()
    ?.replace(/[<>:"|?*\p{Cc}]/gu, "-")
    .slice(0, 120);
  if (!suggestedName || suggestedName === "." || suggestedName === "..") {
    return { success: false, error: "invalid_file_payload" };
  }
  if (!(payload.data instanceof ArrayBuffer)) {
    if (
      payload.data !== undefined ||
      typeof payload.sourceUrl !== "string" ||
      !payload.sourceUrl.trim()
    ) {
      return { success: false, error: "invalid_file_payload" };
    }
    // 私钥导出只需字节；不把 sourceUrl 扩展为带浏览器凭据的任意网络访问。
    return { success: false, error: "source_url_not_supported" };
  }
  if (payload.sourceUrl !== undefined || payload.data.byteLength === 0) {
    return { success: false, error: "invalid_file_payload" };
  }
  if (payload.data.byteLength > MAX_SAVE_FILE_BYTES) {
    return { success: false, error: "file_too_large" };
  }

  let objectUrl: string | undefined;
  let link: HTMLAnchorElement | undefined;
  let initiated = false;
  try {
    objectUrl = URL.createObjectURL(new Blob([payload.data], { type: "application/octet-stream" }));
    link = document.createElement("a");
    link.href = objectUrl;
    link.download = suggestedName;
    document.body.appendChild(link);
    link.click();
    initiated = true;
    // 浏览器只能确认已发起下载，不能伪造本地路径、落盘完成或系统取消结果。
    return { success: true };
  } catch {
    return { success: false, error: "download_failed" };
  } finally {
    try {
      link?.remove();
    } finally {
      if (objectUrl) {
        if (initiated) {
          // 让浏览器先消费下载地址；下一任务只保留 URL，不缓存私钥字节或 Blob。
          setTimeout(URL.revokeObjectURL.bind(URL, objectUrl), 0);
        } else {
          URL.revokeObjectURL(objectUrl);
        }
      }
    }
  }
}
