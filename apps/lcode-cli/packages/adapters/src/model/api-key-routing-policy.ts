import type { ProviderApiKey, ProviderRoutingPolicy } from "@lcode/provider";
/** 新规则只接受策略；旧批量权重和优先级不再改变执行，额度身份由原快照另行管理。 */
export function apiKeyRoutingPolicy(
  policy: ProviderRoutingPolicy,
  _keys: readonly ProviderApiKey[],
): ProviderRoutingPolicy {
  return policy;
}
