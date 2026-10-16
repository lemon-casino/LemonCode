import type {
  RoutingCandidate,
  RoutingStrategy,
  RoutingCacheDecision,
} from "@lcode/shared/provider-routing";
import { compareRoutingScore, routingReliabilityScore } from "./ranking.js";
import { routingExpiryBenefit } from "./values.js";
import type { RoutingRequest } from "@lcode/shared/provider-routing";

/** 缓存是策略之后的稳定性判断；风险档与主排序共用同一规则，不能另造绝对百分点门槛。 */
export function decideRoutingCache(input: {
  strategy: RoutingStrategy;
  effectiveStrategy: RoutingStrategy;
  same: RoutingCandidate;
  best: RoutingCandidate;
  request: RoutingRequest;
  now: number;
  sameTier: number;
  bestTier: number;
  material: boolean;
  newReading: boolean;
}): RoutingCacheDecision {
  const { same, best } = input;
  const decision = (action: "keep" | "switch", reason: string): RoutingCacheDecision => ({
    action,
    reason,
  });
  if (same.id === best.id) return decision("keep", "strategy-winner");
  if (input.sameTier > input.bestTier) return decision("switch", "better-soft-tier");
  if (best.health !== "degraded" && same.health === "degraded")
    return decision("switch", "better-health");
  if (input.strategy === "reliable-first") {
    if (compareRoutingScore(routingReliabilityScore(best), routingReliabilityScore(same)) < 0)
      return decision("switch", "better-reliability-band");
    const a = same.statistics,
      b = best.statistics;
    if (a && b && a.samples >= 8 && b.samples >= 8) {
      if (a.completionMs > 0 && b.completionMs <= a.completionMs * 0.8)
        return decision("switch", "better-latency");
      if (
        a.marginalCost !== undefined &&
        a.marginalCost > 0 &&
        b.marginalCost !== undefined &&
        a.currency &&
        a.currency === b.currency &&
        b.marginalCost <= a.marginalCost * 0.8
      )
        return decision("switch", "better-cost");
    }
  }
  if (input.effectiveStrategy === "expiry-first") {
    const cost = best.cacheSwitchCost;
    if (
      !cost ||
      cost.unit !== best.expiry?.comparableUnit ||
      !Number.isFinite(cost.amount) ||
      cost.amount < 0
    )
      return decision("keep", "cache-cost-unverifiable");
    const gain =
      routingExpiryBenefit(best, input.request, input.now) -
      routingExpiryBenefit(same, input.request, input.now);
    return decision(
      gain > cost.amount ? "switch" : "keep",
      gain > cost.amount ? "positive-expiry-net-benefit" : "cache-rebuild-exceeds-benefit",
    );
  }
  return input.material && input.newReading
    ? decision("switch", "headroom-new-reading")
    : decision("keep", "warm-cache");
}
