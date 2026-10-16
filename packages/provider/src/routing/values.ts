import type {
  ProviderRoutingPolicy,
  RoutingTokens,
  RoutingCandidate,
  RoutingRequest,
} from "@lcode/shared/provider-routing";

export const routingConcurrency = (policy: ProviderRoutingPolicy, candidate: RoutingCandidate) =>
  Math.min(
    candidate.maxInFlight ?? Infinity,
    policy.maxInFlightPerCandidate ?? 2,
    candidate.windows.length ? Infinity : 1,
  );
export const routingWeight = (policy: ProviderRoutingPolicy, id: string) =>
  policy.weights && Object.hasOwn(policy.weights, id) ? policy.weights[id]! : 1;
export function routingDemand(
  demands: Readonly<Record<string, number>> | undefined,
  id: string,
  unit?: string,
  tokens?: RoutingTokens,
): number | undefined {
  if (demands && Object.hasOwn(demands, id)) return demands[id];
  if (unit === "requests") return 1;
  if (unit === "tokens") return tokens?.total;
  if (unit === "input_tokens") return tokens?.input;
  if (unit === "output_tokens") return tokens?.output;
  return undefined;
}
export function routingExpiryBenefit(
  candidate: RoutingCandidate,
  request: RoutingRequest,
  now: number,
): number {
  const expiry = candidate.expiry;
  if (!expiry || expiry.expiresAt <= now || expiry.expiresAt - now > 3_600_000) return 0;
  const window = candidate.windows.find((item) => item.resourceId === expiry.resourceId);
  const demand = expiry.resourceId
    ? routingDemand(request.demands, expiry.resourceId, window?.unit, request.tokens)
    : request.workUnits;
  return Math.min(expiry.predictedWaste, demand ?? 0);
}
