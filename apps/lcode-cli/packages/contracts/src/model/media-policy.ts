import {
  modelMessageContentToText,
  type ModelInputFormat,
  type ModelMessageContentBlock,
} from "./index.js";

export type UnsupportedModelInputMediaKind = "image input" | "PDF input" | "video input";

export function isProviderVisibleModelInputMediaBlock(block: ModelMessageContentBlock): boolean {
  return (
    block.type === "image" ||
    isProviderVisiblePdfModelInputBlock(block) ||
    isProviderVisibleVideoModelInputBlock(block)
  );
}

export function isProviderVisiblePdfModelInputBlock(block: ModelMessageContentBlock): boolean {
  return (
    block.type === "file" &&
    block.mediaType.split(";", 1)[0]?.trim().toLowerCase() === "application/pdf" &&
    block.dataUrl !== undefined &&
    // PDF 提取文本为空字符串时，adapter 会回退发送 file-data。
    // 只有非空文本能替代 provider-visible PDF 文件数据。
    (block.text === undefined || block.text.length === 0)
  );
}

export function isProviderVisibleVideoModelInputBlock(block: ModelMessageContentBlock): boolean {
  return (
    (block.type === "video" || block.type === "file") &&
    block.mediaType.toLowerCase().startsWith("video/") &&
    block.dataUrl !== undefined
  );
}

export function getUnsupportedModelInputMediaKind(
  block: ModelMessageContentBlock,
  inputFormat: ModelInputFormat,
): UnsupportedModelInputMediaKind | undefined {
  if (block.type === "image" && !inputFormat.supportsImage) {
    return "image input";
  }
  if (isProviderVisiblePdfModelInputBlock(block) && !inputFormat.supportsPdf) {
    return "PDF input";
  }
  if (isProviderVisibleVideoModelInputBlock(block) && !inputFormat.supportsVideo) {
    return "video input";
  }
  return undefined;
}

export function createUnsupportedModelInputMediaText(
  block: ModelMessageContentBlock,
  unsupportedKind: UnsupportedModelInputMediaKind,
): string {
  const placeholder = modelMessageContentToText([block]) || "[Attached media]";
  return `${placeholder}\n[Media omitted from provider request because the selected model does not support ${unsupportedKind}.]`;
}
