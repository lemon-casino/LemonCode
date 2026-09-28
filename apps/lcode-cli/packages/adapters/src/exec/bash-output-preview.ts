import type { ExecutionOutputPreview } from "@lcode/contracts";

const SHORT_PREVIEW_LINES = 5;
const FULL_PREVIEW_LINES = 100;

/** 只扫描本次有界尾读；原始字节数用于 Windows 编码下的行数估计。 */
export function buildBashOutputPreview(
  text: string,
  bytesRead: number,
  totalBytes: number,
  previousLines: number,
): ExecutionOutputPreview {
  let cursor = text.length;
  let shortStart = 0;
  let fullStart = 0;
  let lines = 0;
  while (cursor > 0) {
    cursor = text.lastIndexOf("\n", cursor - 1);
    lines += 1;
    if (lines === SHORT_PREVIEW_LINES) shortStart = cursor <= 0 ? 0 : cursor + 1;
    if (lines === FULL_PREVIEW_LINES) fullStart = cursor <= 0 ? 0 : cursor + 1;
  }
  const linesEstimated = bytesRead > 0 && bytesRead < totalBytes;
  const totalLines =
    bytesRead === 0
      ? previousLines
      : linesEstimated
        ? Math.max(previousLines, Math.round((totalBytes / bytesRead) * lines))
        : lines;
  return {
    text: text.slice(shortStart),
    fullText: text.slice(fullStart),
    totalLines,
    totalBytes,
    linesEstimated,
  };
}
