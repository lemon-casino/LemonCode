import type {
  RoutingCandidate,
  RoutingRequest,
  RoutingStrategy,
} from "@lcode/shared/provider-routing";
import { routingExpiryBenefit } from "./values.js";
export const routingReady = (candidate: RoutingCandidate) =>
  Boolean(candidate.statistics && candidate.statistics.samples >= 8);
export const routingQuotaKnown = (candidate: RoutingCandidate, now: number) =>
  candidate.windows.some(
    (window) =>
      window.quality === "fresh" &&
      !(window.resetAt !== undefined && window.resetAt <= now) &&
      !(window.expiresAt !== undefined && window.expiresAt <= now) &&
      (window.remaining !== undefined || window.usedPercent !== undefined),
  );
export const routingExpiryUsable = (candidate: RoutingCandidate, now: number) =>
  Boolean(
    candidate.expiry &&
    candidate.expiry.predictedWaste > 0 &&
    candidate.expiry.expiresAt > now &&
    candidate.expiry.expiresAt - now <= 3_600_000,
  );
export interface RoutingRank {
  candidate: RoutingCandidate;
  index: number;
  tier: number;
  pressure: number;
  load: number;
  eligible: boolean;
  eligibleRound: number;
  now: number;
  expires: number;
}
export function routingScore(
  strategy: RoutingStrategy,
  candidate: RoutingCandidate,
  request: RoutingRequest,
  rank: {
    tier: number;
    pressure: number;
    load: number;
    index: number;
    ring: number;
    positive: boolean;
    pricesKnown: boolean;
    now: number;
  },
): number[] {
  const result = [rank.tier];
  if (strategy === "primary-backup") return [...result, rank.index];
  if (strategy === "share-rotation") return [...result, rank.positive ? 0 : 1, rank.ring];
  const ready = routingReady(candidate);
  if (strategy === "reliable-first") {
    result.push(
      Number(candidate.health === "degraded"),
      ready ? (candidate.statistics!.failureRate < 0.05 ? 0 : 2) : 1,
    );
    result.push(
      ready ? Math.floor(candidate.statistics!.failureRate / 0.05) : 0,
      ready ? Math.floor(Math.log1p(candidate.statistics!.completionMs) / Math.log(1.15)) : 0,
      ready && rank.pricesKnown ? (candidate.statistics!.marginalCost ?? 0) : 0,
    );
  }
  if (strategy === "expiry-first") {
    const benefit = routingExpiryBenefit(candidate, request, rank.now);
    result.push(-benefit, benefit > 0 ? candidate.expiry!.expiresAt : 0);
  }
  return [
    ...result,
    routingQuotaKnown(candidate, rank.now) ? 0 : 1,
    Math.floor(rank.pressure / 0.05),
    rank.load,
    rank.index,
  ];
}
export function compareRoutingScore(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < a.length; i++) {
    const difference = a[i]! - b[i]!;
    if (difference) return difference;
  }
  return 0;
}
