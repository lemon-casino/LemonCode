import { sanitizeModelNetworkHeaders } from "./runner-network-headers.js";

export function sanitizeModelIODebugRecord(
  record: Record<string, unknown>,
): Record<string, unknown> {
  const request = sanitizeModelIOSectionHeaders(asRecord(record.request));
  const response = sanitizeModelIOSectionHeaders(asRecord(record.response));
  return redactModelIOImageAndVideoData({
    ...record,
    ...(request ? { request } : {}),
    ...(response ? { response } : {}),
  }) as Record<string, unknown>;
}

function sanitizeModelIOSectionHeaders(
  section: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!section || !Object.hasOwn(section, "headers")) {
    return section;
  }
  return {
    ...section,
    headers: sanitizeModelNetworkHeaders(section.headers),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// 内部 dataUrl、AI SDK image/file 与 provider wire 的媒体键名不同，
// 分散在调用方脱敏会遗漏 image/video 形态；统一在 model-I/O 落盘边界递归处理。
function redactModelIOImageAndVideoData(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactModelIOImageAndVideoData(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const record = value as Record<string, unknown>;
  const rawDataMediaType =
    record.type === "base64" && typeof record.media_type === "string"
      ? record.media_type
      : (record.type === "file" || record.type === "image") && typeof record.mediaType === "string"
        ? record.mediaType
        : undefined;
  const rawDataKey = record.type === "image" ? "image" : "data";
  const isRawImageOrVideo = isImageOrVideoMimeType(rawDataMediaType);
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    if (typeof child === "string") {
      const dataUrlMimeType = readDataUrlMimeType(child);
      if (isImageOrVideoMimeType(dataUrlMimeType)) {
        result[key] = `[${key} omitted from model-io: ${dataUrlMimeType}, ${child.length} chars]`;
        continue;
      }
      if (key === rawDataKey && isRawImageOrVideo) {
        result[key] = `[${key} omitted from model-io: ${rawDataMediaType}, ${child.length} chars]`;
        continue;
      }
    }
    result[key] = redactModelIOImageAndVideoData(child);
  }
  return result;
}

function readDataUrlMimeType(dataUrl: string): string {
  const match = /^data:([^;,]+)[;,]/.exec(dataUrl);
  return match?.[1] ?? "unknown";
}

function isImageOrVideoMimeType(mimeType: string | undefined): boolean {
  // MIME type 大小写不敏感，直接比较会让非规范大小写绕过日志脱敏。
  const normalized = mimeType?.trim().toLowerCase();
  return normalized?.startsWith("image/") === true || normalized?.startsWith("video/") === true;
}
