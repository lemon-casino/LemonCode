const words = (list) =>
  Array.isArray(list)
    ? [
        ...new Set(list.filter((x) => typeof x === "string" && /^[a-z0-9_-]{1,40}$/i.test(x))),
      ].slice(0, 32)
    : [];
function variantOptions(value) {
  const out = {};
  if (!value || typeof value !== "object") return out;
  for (const key of ["reasoningEffort", "effort"])
    if (words([value[key]]).length) out[key] = value[key];
  const t = value.thinking;
  if (t && ["enabled", "disabled", "adaptive"].includes(t.type)) {
    out.thinking = { type: t.type };
    if (Number.isSafeInteger(t.budgetTokens) && t.budgetTokens >= 0)
      out.thinking.budgetTokens = t.budgetTokens;
  }
  const c = value.thinkingConfig;
  if (c && typeof c === "object") {
    const thinking = {};
    if (typeof c.includeThoughts === "boolean") thinking.includeThoughts = c.includeThoughts;
    if (words([c.thinkingLevel]).length) thinking.thinkingLevel = c.thinkingLevel;
    if (Number.isSafeInteger(c.thinkingBudget) && c.thinkingBudget >= -1)
      thinking.thinkingBudget = c.thinkingBudget;
    if (Object.keys(thinking).length) out.thinkingConfig = thinking;
  }
  return out;
}
export function modelDetails(model) {
  const knownModalities = ["text", "image", "video", "audio", "pdf"];
  const modalities = Array.isArray(model.modalities?.input)
    ? model.modalities.input.filter((item) => knownModalities.includes(item))
    : model.capabilities?.input && typeof model.capabilities.input === "object"
      ? knownModalities.filter((item) => model.capabilities.input[item] === true)
      : undefined;
  const variants = Object.entries(model.variants ?? {})
    .slice(0, 32)
    .flatMap(([id, value]) => {
      const options = variantOptions(value);
      return words([id]).length && Object.keys(options).length ? [{ id, options }] : [];
    });
  const efforts = words(model.reasoningEfforts ?? variants.map((v) => v.id));
  const tiers = words(model.serviceTiers ?? (model.fast === true ? ["default", "priority"] : []));
  const toolCall = model.capabilities?.toolcall ?? model.tool_call;
  return {
    ...(modalities ? { inputModalities: [...new Set(modalities)] } : {}),
    ...(variants.length ? { reasoningVariants: variants } : {}),
    ...(efforts.length ? { reasoningEfforts: efforts } : {}),
    ...(tiers.length ? { serviceTiers: tiers } : {}),
    ...(typeof toolCall === "boolean" ? { toolCall } : {}),
    ...(Number.isSafeInteger(model.maxContextWindow) && model.maxContextWindow > 0
      ? { maxContextWindow: model.maxContextWindow }
      : {}),
  };
}
