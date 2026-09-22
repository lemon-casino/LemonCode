import type { Model, ResolvedModelOptions } from "@zcode/contracts";

const AUXILIARY_MAX_OUTPUT_TOKENS = 5_000;

/**
 * 辅助调用统一使用公开档位的最低项，并限制输出预算；档位顺序来自 Model Config，
 * 不能再按 disabled/off 等名字推断协议行为。
 */
export function auxiliaryModelOptions(model: Model): ResolvedModelOptions {
  return {
    reasoningLevel: model.optionSpecs.reasoningLevel.values[0]!,
    maxOutputTokens: Math.min(AUXILIARY_MAX_OUTPUT_TOKENS, model.optionSpecs.maxOutputTokens.max),
    ...(model.optionSpecs.speed?.values[0] ? { speed: model.optionSpecs.speed.values[0] } : {}),
  };
}
