import type { ProviderRoutingPolicy } from "@lcode/shared/provider-routing";

export const routingWeight = (policy: ProviderRoutingPolicy, id: string) =>
  policy.weights && Object.hasOwn(policy.weights, id) ? policy.weights[id]! : 1;
export const routingDemand = (demands: Readonly<Record<string, number>> | undefined, id: string) =>
  demands && Object.hasOwn(demands, id) ? demands[id] : undefined;
