import type { ProviderApiKey, ProviderRoutingPolicy } from "@lcode/provider";
/** 只在目录/配置变化时构建；批量元数据不膨胀日常 Settings View 的策略字段。 */
export function apiKeyRoutingPolicy(
  policy: ProviderRoutingPolicy,
  keys: readonly ProviderApiKey[],
): ProviderRoutingPolicy {
  const weighted = keys.filter((key) => key.routing?.weight !== undefined);
  const hasPriority = keys.some((key) => key.routing?.priority !== undefined);
  if (!weighted.length && !hasPriority) return policy;
  const weights = Object.fromEntries(weighted.map((key) => [key.id, key.routing!.weight!]));
  const leading = policy.order ?? [];
  const listed = new Set(leading);
  const ordered = hasPriority
    ? [...keys]
        .sort((a, b) => (a.routing?.priority ?? Infinity) - (b.routing?.priority ?? Infinity))
        .map((key) => key.id)
    : undefined;
  return {
    ...policy,
    ...(weighted.length ? { weights: { ...weights, ...policy.weights } } : {}),
    ...(ordered ? { order: [...leading, ...ordered.filter((id) => !listed.has(id))] } : {}),
  };
}
