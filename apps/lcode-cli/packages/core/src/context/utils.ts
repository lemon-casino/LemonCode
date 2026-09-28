// ============================================================
// Token Estimation
// ============================================================

import { ESTIMATED_TOKEN_CHAR_DIVISOR } from "@lcode/shared";

/**
 * 估算文本的 token 数量
 * 使用共享字符估算除数，中文字符保留额外权重
 * 这是一个粗略估算，对于调试和监控足够用
 */
export function estimateTokens(text: string): number {
  // 中文字符通常比英文字符占用更多 token，因此按两个估算字符计入。
  const chineseChars = (text.match(/[一-鿿]/g) || []).length;
  const otherChars = text.length - chineseChars;

  return Math.ceil((chineseChars * 2 + otherChars) / ESTIMATED_TOKEN_CHAR_DIVISOR);
}
