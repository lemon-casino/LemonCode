import {
  createUnsupportedModelInputMediaText,
  getUnsupportedModelInputMediaKind,
  type ModelInputFormat,
  type ModelMessageContentBlock,
} from "@lcode/contracts";

export function unsupportedInputMediaText(
  block: ModelMessageContentBlock,
  inputFormat: ModelInputFormat | undefined,
): string | undefined {
  if (!inputFormat) return undefined;
  const unsupportedKind = getUnsupportedModelInputMediaKind(block, inputFormat);
  return unsupportedKind ? createUnsupportedModelInputMediaText(block, unsupportedKind) : undefined;
}

export function dataUrlToDataContent(
  dataUrl: string,
): { mediaType: string; data: string } | undefined {
  // Provider 格式重构与 PDF 支持发生冲突时，旧正则解析和新实现的
  // 返回语句被错误拼接，导致 mediaType 未定义。保留统一的 ModelInputFormat，
  // 同时完整采用支持参数化 Data URL 的解析路径，避免再次混用两套实现。
  const commaIndex = dataUrl.indexOf(",");
  if (dataUrl.slice(0, "data:".length).toLowerCase() !== "data:" || commaIndex < 0) {
    return undefined;
  }
  const headerParts = dataUrl.slice("data:".length, commaIndex).split(";");
  const mediaType = headerParts.shift()?.trim();
  if (headerParts.at(-1)?.trim().toLowerCase() !== "base64" || !mediaType) return undefined;
  const data = dataUrl.slice(commaIndex + 1);
  if (data.length === 0) return undefined;
  return { mediaType: mediaType.toLowerCase(), data };
}
