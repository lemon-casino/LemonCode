import type {
  ProviderRoutingPolicy,
  RoutingCandidate,
  RoutingPlan,
  RoutingRequest,
  RoutingStrategy,
  RoutingQuotaScore,
} from "@lcode/shared/provider-routing";
import type { RoutingLedger } from "./ledger.js";
import { routingDemand, routingExpiryBenefit, routingConcurrency } from "./values.js";
import { routingQuotaScore } from "./quota-score.js";
import { decideRoutingCache } from "./cache-decision.js";
import { routingScore, compareRoutingScore } from "./ranking.js";

export interface RoutingBinding {
  cacheGroupId?: string;
  routeId: string;
  generation: string;
  turnId?: string;
  portability: RoutingCandidate["portability"];
  cacheUntil: number;
  pressure: number;
  readingRevision: number;
  readingSequence?: number;
  readings?: ReadonlyMap<string, number>;
}
export interface PlanningState {
  orderIndex?: ReadonlyMap<string, number>;
  directorySize?: number;
  revision: number;
  now: number;
  inFlight: ReadonlyMap<string, number>;
  credit: ReadonlyMap<string, number>;
  cursor: number;
  selections?: number;
  ledger: RoutingLedger;
  binding?: RoutingBinding;
}
const PRESSURE_BAND = 0.05,
  MIN_SAMPLES = 8,
  FORECAST_HORIZON = 3_600_000;
export const routingWindowKey = (window: RoutingCandidate["windows"][number]) =>
  JSON.stringify([window.resourceId, window.instanceId]);

export function planRouting(
  policy: ProviderRoutingPolicy,
  candidates: readonly RoutingCandidate[],
  request: RoutingRequest,
  state: PlanningState,
): RoutingPlan {
  const excluded: Record<string, string> = Object.create(null),
    available: Record<string, number> = Object.create(null),
    pressures: Record<string, number> = Object.create(null),
    quotaScores: Record<string, RoutingQuotaScore> = Object.create(null);
  const rank = state.orderIndex ?? new Map(policy.order?.map((id, index) => [id, index]));
  const listed = candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort(
      (a, b) =>
        (rank.get(a.candidate.id) ?? rank.size + a.index) -
        (rank.get(b.candidate.id) ?? rank.size + b.index),
    )
    .map(({ candidate }) => candidate);
  const binding = state.binding;
  const fresh = (window: RoutingCandidate["windows"][number]) =>
    window.quality === "fresh" &&
    !(window.resetAt !== undefined && window.resetAt <= state.now) &&
    !(window.expiresAt !== undefined && window.expiresAt <= state.now);
  const sameTurn = binding && request.turnId !== undefined && binding.turnId === request.turnId;
  const sessionBound = binding?.portability === "provider-session-bound";
  const hardBound = binding && (sessionBound || (sameTurn && binding.portability !== "portable"));
  let softTier = new Map<string, number>();
  for (const candidate of listed) {
    let why = candidate.unavailable ?? (candidate.health === "open" ? "route-cooling" : undefined);
    const maxInFlight = routingConcurrency(policy, candidate);
    if ((state.inFlight.get(candidate.id) ?? 0) >= maxInFlight) why ??= "concurrency-full";
    if (
      hardBound &&
      (binding.routeId !== candidate.id || binding.generation !== candidate.generation)
    )
      why ??= "binding-blocked";
    let tier = 0;
    for (const original of candidate.windows) {
      const window = state.ledger.reading(original);
      if (window.kind === "informational") continue;
      if (window.expiresAt !== undefined && window.expiresAt <= state.now)
        why ??= "quota-exhausted";
      if (
        !window.coordinated &&
        state.ledger.needsProbe(window, state.now, request) &&
        state.ledger.probeBlocked(window)
      )
        why ??= "reserve-unverifiable";
      const left = state.ledger.available(window),
        demand = routingDemand(request.demands, window.resourceId, window.unit, request.tokens);
      if (left !== undefined) available[window.resourceId] = left;
      const exhausted =
        left === 0 ||
        window.usedPercent === 100 ||
        (demand !== undefined && left !== undefined && demand > left);
      if (fresh(window) && exhausted) why ??= "quota-exhausted";

      const rule = policy.reserveRules?.find((item) => item.resourceId === window.resourceId);
      if (rule) {
        const verified =
          left !== undefined &&
          window.limit !== undefined &&
          window.limit > 0 &&
          demand !== undefined &&
          (!window.unit?.includes("tokens") || request.tokens?.quality !== "estimated") &&
          fresh(window) &&
          window.stableId !== false &&
          window.kind !== "unknown";
        if (rule.mode === "hard" && !verified) why ??= "reserve-unverifiable";
        if (!verified || ((left! - demand!) / window.limit!) * 100 < rule.minRemainingPercent) {
          if (rule.mode === "hard" && verified) why ??= "quota-exhausted";
          tier = 1;
        }
      }
    }
    for (const rule of policy.reserveRules ?? [])
      if (
        rule.mode === "hard" &&
        !candidate.windows.some((window) => window.resourceId === rule.resourceId)
      )
        why ??= "reserve-unverifiable";
    const quota = routingQuotaScore(candidate, request, state.now, state.ledger);
    quotaScores[candidate.id] = quota;
    pressures[candidate.id] = quota.pressure;
    softTier.set(candidate.id, tier);
    if (why) excluded[candidate.id] = why;
  }
  let routes = listed.filter((candidate) => !excluded[candidate.id]);
  const ready = (candidate: RoutingCandidate) =>
    Boolean(candidate.statistics && candidate.statistics.samples >= MIN_SAMPLES);
  const knownQuota = (candidate: RoutingCandidate) => quotaScores[candidate.id]!.quality < 2;
  let effectiveStrategy: RoutingStrategy = policy.strategy,
    fallbackReason: string | undefined;
  if (
    effectiveStrategy === "reliable-first" &&
    !routes.some(
      (candidate) => ready(candidate) || knownQuota(candidate) || candidate.health === "degraded",
    ) &&
    !(binding && binding.cacheUntil > state.now && policy.cacheMode !== "turn-only")
  ) {
    effectiveStrategy = "share-rotation";
    fallbackReason = "signals-unknown";
  }
  if (effectiveStrategy === "expiry-first") {
    const units = new Set(
      routes
        .filter((candidate) => candidate.expiry)
        .map((candidate) => candidate.expiry!.comparableUnit),
    );
    if (
      units.size !== 1 ||
      !routes.some(
        (candidate) =>
          candidate.expiry &&
          candidate.expiry.predictedWaste > 0 &&
          routingExpiryBenefit(candidate, request, state.now) > 0 &&
          candidate.expiry.expiresAt > state.now &&
          candidate.expiry.expiresAt - state.now <= FORECAST_HORIZON,
      )
    ) {
      effectiveStrategy = "headroom-balance";
      fallbackReason = "expiry-unverifiable";
    }
  }
  if (effectiveStrategy === "headroom-balance" && !routes.some(knownQuota)) {
    effectiveStrategy = "share-rotation";
    fallbackReason ??= "quota-unknown";
  }
  if (
    effectiveStrategy === "headroom-balance" &&
    new Set(
      routes
        .filter((candidate) => quotaScores[candidate.id]!.quality === 0)
        .map((candidate) => quotaScores[candidate.id]!.dimensions),
    ).size > 1
  ) {
    effectiveStrategy = "share-rotation";
    fallbackReason ??= "quota-incomparable";
  }
  const completeQuota = routes.some((candidate) => quotaScores[candidate.id]!.quality === 0);
  const statisticsKnown =
    routes.length > 0 &&
    routes.every(
      (candidate) => candidate.statistics && candidate.statistics.samples >= MIN_SAMPLES,
    );
  const quality = (candidate: RoutingCandidate) =>
    (completeQuota ? quotaScores[candidate.id]!.quality === 0 : knownQuota(candidate)) ? 0 : 1;
  const pricesKnown =
    statisticsKnown &&
    routes.every(
      (candidate) =>
        candidate.statistics!.marginalCost !== undefined && Boolean(candidate.statistics!.currency),
    ) &&
    new Set(routes.map((candidate) => candidate.statistics!.currency)).size === 1;
  const indexOf =
    state.orderIndex ?? new Map(listed.map((candidate, index) => [candidate.id, index]));
  const ring = (id: string) =>
    ((indexOf.get(id) ?? 0) - state.cursor + (state.directorySize ?? listed.length)) %
    Math.max(1, state.directorySize ?? listed.length);
  const score = (candidate: RoutingCandidate) =>
    routingScore(effectiveStrategy, candidate, request, {
      tier: softTier.get(candidate.id) ?? 0,
      pressure: pressures[candidate.id]!,
      load: (state.inFlight.get(candidate.id) ?? 0) / routingConcurrency(policy, candidate),
      concurrency: routingConcurrency(policy, candidate),
      quota: quotaScores[candidate.id],
      index: indexOf.get(candidate.id)!,
      ring: ring(candidate.id),
      positive: (state.credit.get(candidate.id) ?? 1) > 0,
      pricesKnown,
      now: state.now,
    });
  routes.sort((a, b) => compareRoutingScore(score(a), score(b)));
  let cacheDecision: RoutingPlan["cacheDecision"];
  let reason: string = effectiveStrategy;
  if (binding) {
    const at = routes.findIndex(
      (candidate) =>
        candidate.id === binding.routeId && candidate.generation === binding.generation,
    );
    if (at >= 0) {
      const same = routes[at]!,
        best = routes[0];
      let keep = Boolean(sameTurn || sessionBound);
      if (
        !keep &&
        policy.cacheMode !== "turn-only" &&
        binding.cacheUntil > state.now &&
        best &&
        !(best.cacheGroupId && best.cacheGroupId === binding.cacheGroupId) &&
        policy.strategy !== "primary-backup" &&
        policy.strategy !== "share-rotation"
      ) {
        const material = pressures[same.id]! - pressures[best.id]! >= PRESSURE_BAND;
        const newReading = [...same.windows, ...best.windows].some((original) => {
          const window = state.ledger.reading(original);
          // 候选省略只影响展示，不能把已存在的高修订当成新事实。
          if (binding.readingSequence !== undefined)
            return state.ledger.changedSince(window, binding.readingSequence);
          const previous =
            binding.readings?.get(routingWindowKey(window)) ?? binding.readingRevision;
          return window.revision > previous;
        });
        cacheDecision = decideRoutingCache({
          strategy: policy.strategy,
          effectiveStrategy,
          same,
          best,
          request,
          now: state.now,
          sameTier: softTier.get(same.id) ?? 0,
          bestTier: softTier.get(best.id) ?? 0,
          material,
          newReading,
          sameLoad: (state.inFlight.get(same.id) ?? 0) / routingConcurrency(policy, same),
          bestLoad: (state.inFlight.get(best.id) ?? 0) / routingConcurrency(policy, best),
        });
        keep = cacheDecision.action === "keep";
      }
      if (keep) {
        routes = [same, ...routes.filter((candidate) => candidate !== same)];
        reason = sameTurn ? "turn-binding" : sessionBound ? "session-binding" : "warm-cache";
      }
    } else if (hardBound) {
      routes = [];
      reason = "binding-blocked";
    }
  }
  const explorationQuality = (candidate: RoutingCandidate) =>
    policy.strategy === "reliable-first" && ready(candidate) ? 0 : quality(candidate);
  if (
    (policy.strategy === "headroom-balance" || policy.strategy === "reliable-first") &&
    reason !== "turn-binding" &&
    reason !== "session-binding" &&
    ((state.selections ?? 0) + 1) % 32 === 0 &&
    routes.some((candidate) => explorationQuality(candidate) === 0)
  ) {
    const unknown = routes
      .filter(
        (candidate) =>
          explorationQuality(candidate) === 1 &&
          candidate.health !== "degraded" &&
          softTier.get(candidate.id) === softTier.get(routes[0]!.id),
      )
      .sort((a, b) => ring(a.id) - ring(b.id))[0];
    if (unknown) {
      routes = [unknown, ...routes.filter((candidate) => candidate !== unknown)];
      reason = "bounded-exploration";
      if (binding)
        cacheDecision = { action: unknown.id === binding.routeId ? "keep" : "switch", reason };
    }
  }
  return {
    ...(cacheDecision ? { cacheDecision } : {}),
    tiers: Object.fromEntries(softTier),
    revision: state.revision,
    routes: routes.slice(0, 32).map((candidate) => candidate.id),
    effectiveStrategy,
    ...(fallbackReason ? { fallbackReason } : {}),
    excluded,
    available,
    pressures,
    quotaScores,
    reason,
  };
}
