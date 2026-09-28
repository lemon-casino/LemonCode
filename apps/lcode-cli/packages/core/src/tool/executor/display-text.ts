/**
 * display 文本的字节限长助手。从 result-display.ts 拆出：观察类工作流 display 的构造
 * （workflow-observation-display.ts）与既有 payload 构造共用同一道截断语义，而两个文件
 * 互相 import 会成环，助手必须住在双方都能依赖的第三处。
 */

const DISPLAY_TRUNCATION_SUFFIX = "\n...[truncated]";

export function boundDisplayText(value: string, maxBytes: number): { value: string; truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return { value, truncated: false };
  }

  const suffixBytes = Buffer.byteLength(DISPLAY_TRUNCATION_SUFFIX, "utf8");
  const prefix = fitUtf8Prefix(value, maxBytes - suffixBytes);
  return {
    value: `${prefix}${DISPLAY_TRUNCATION_SUFFIX}`,
    truncated: true,
  };
}

function fitUtf8Prefix(value: string, maxBytes: number): string {
  const codePoints = Array.from(value);
  let low = 0;
  let high = codePoints.length;

  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = codePoints.slice(0, mid).join("");
    if (Buffer.byteLength(candidate, "utf8") <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return codePoints.slice(0, low).join("");
}
