import { providerAccountReasoningOptionsSchema } from "@lcode/shared";
import type { AuthModel } from "./driver.js";

const ORDER = [
  "none",
  "off",
  "disabled",
  "minimal",
  "low",
  "medium",
  "on",
  "enabled",
  "high",
  "xhigh",
  "max",
  "ultra",
];
function sorted(values: readonly string[]) {
  return [...new Set(values)]
    .filter((v) => v !== "default")
    .sort((a, b) => {
      const index = (v: string) => {
        const n = ORDER.indexOf(v.toLowerCase());
        return n < 0 ? ORDER.length : n;
      };
      return index(a) - index(b);
    });
}
function wireOptions(model: AuthModel, raw: Record<string, unknown>): Record<string, unknown> {
  const options = providerAccountReasoningOptionsSchema.parse(raw);
  const out: Record<string, unknown> = {};
  const effort = options.reasoningEffort;
  if (effort !== undefined) {
    if (model.protocol === "openai-responses") out.reasoning = { effort };
    else if (model.protocol === "openai-chat-completions") out.reasoning_effort = effort;
    else out.output_config = { effort };
  }
  if (options.effort !== undefined) out.output_config = { effort: options.effort };
  if (options.thinking)
    out.thinking = {
      ...(options.thinking.type ? { type: options.thinking.type } : {}),
      ...(options.thinking.budgetTokens !== undefined
        ? { budget_tokens: options.thinking.budgetTokens }
        : {}),
    };
  if (options.thinkingConfig) {
    const thinking = options.thinkingConfig;
    // Google渠道复用Anthropic请求桥；原SDK的thinkingConfig会被忽略，需先映射到桥接受的字段。
    if (model.protocol === "anthropic-messages") {
      if (thinking.thinkingLevel !== undefined) {
        out.thinking = { type: "adaptive" };
        out.output_config = { effort: thinking.thinkingLevel };
      } else if (thinking.thinkingBudget !== undefined) {
        out.thinking =
          thinking.thinkingBudget === 0
            ? { type: "disabled" }
            : { type: "enabled", budget_tokens: thinking.thinkingBudget };
      }
    } else out.thinkingConfig = thinking;
  }
  return out;
}
/** Pure catalog projection. Actual requests use the same option-map interpreter as API models. */
export function createAuthModelOptionSpecs(model: AuthModel) {
  const variants = new Map(
    (model.reasoningVariants ?? []).map((variant) => [
      variant.id,
      wireOptions(model, variant.options),
    ]),
  );
  for (const effort of model.reasoningEfforts ?? [])
    if (!variants.has(effort))
      variants.set(effort, wireOptions(model, { reasoningEffort: effort }));
  const values = ["default", ...sorted([...variants.keys()])];
  const map = values
    .filter((value) => value !== "default")
    .reduceRight(
      (tail, value) =>
        `reasoningLevel == ${JSON.stringify(value)} ? ${JSON.stringify(variants.get(value))} : ${tail}`,
      "{}",
    );
  const tiers = ["default", ...new Set((model.serviceTiers ?? []).filter((v) => v !== "default"))];
  const outputField = model.protocol === "openai-responses" ? "max_output_tokens" : "max_tokens";
  return {
    reasoningLevel: { values, map },
    maxOutputTokens: {
      max: model.maxOutputTokens ?? 8192,
      map: `{${JSON.stringify(outputField)}: maxOutputTokens}`,
    },
    ...(tiers.length > 1
      ? {
          speed: {
            values: tiers,
            map: tiers
              .filter((tier) => tier !== "default")
              .reduceRight(
                (tail, tier) =>
                  `speed == ${JSON.stringify(tier)} ? ${JSON.stringify({ service_tier: tier })} : ${tail}`,
                '{"service_tier": null}',
              ),
          },
        }
      : {}),
  };
}
