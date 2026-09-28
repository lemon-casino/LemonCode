// video 附件共用的 mime 推断与大小校验。
// Read 工具（read-video.ts）与 prompt 附件解析（attachments.ts）都从这里取，
// 保证扩展名→mime 的映射只有一份事实；mime 枚举的唯一事实源在 contracts（ReadVideoOutput）。
import type { ReadVideoOutput } from "@lcode/contracts";
import { base64PayloadByteLength, isStrictBase64Payload } from "./attachment-data-url.js";

export type VideoInputMimeType = ReadVideoOutput["mimeType"];

const VIDEO_INPUT_MIME_BY_EXTENSION: Record<string, VideoInputMimeType> = {
  ".mp4": "video/mp4",
  ".m4v": "video/x-m4v",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
};

/** 按扩展名推断视频 mime；非受支持视频扩展名返回 undefined。 */
export function inferVideoMimeFromPath(path: string): VideoInputMimeType | undefined {
  const lower = path.toLowerCase();
  for (const [extension, mime] of Object.entries(VIDEO_INPUT_MIME_BY_EXTENSION)) {
    if (lower.endsWith(extension)) return mime;
  }
  return undefined;
}

export function parseInlineVideoDataUrl(
  dataUrl: string,
): { mediaType: string; sizeBytes: number } | undefined {
  const match = /^data:([^;,]+);base64,(.*)$/i.exec(dataUrl);
  const mediaType = match?.[1]?.toLowerCase();
  const payload = match?.[2];
  // video inline 过去只检查宽松 data URL header，缺少 base64 标记、
  // 非法正文和非 video MIME 会继续进入持久化或通用文本分支。
  if (
    !mediaType?.startsWith("video/") ||
    payload === undefined ||
    !isStrictBase64Payload(payload)
  ) {
    return undefined;
  }
  return { mediaType, sizeBytes: base64PayloadByteLength(payload) };
}
