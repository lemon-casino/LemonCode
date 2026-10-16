import { RoutingError, type RoutingRequest } from "@lcode/provider";
/** 缺少 tokenizer 时使用模型输入边界；输出未指定时也用 context 上界，绝不伪造实测量。 */
export function apiKeyTokenBounds(
  contextWindow?: number,
  maxOutputTokens?: number,
): NonNullable<RoutingRequest["tokens"]> {
  for (const value of [contextWindow, maxOutputTokens])
    if (value !== undefined && (!Number.isFinite(value) || value < 0))
      throw new RoutingError("invalid-work-estimate");
  const input = contextWindow && contextWindow > 0 ? contextWindow : undefined;
  const output = maxOutputTokens ?? input;
  return {
    input,
    output,
    total: input !== undefined && output !== undefined ? input + output : undefined,
    quality: "bound",
  };
}
