import type {
  RoutingCandidate,
  RoutingRequest,
  RoutingStrategy,
  RoutingQuotaScore,
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
      ((window.remaining !== undefined && window.limit !== undefined && window.limit > 0) ||
        window.usedPercent !== undefined),
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
  concurrency?: number;
  quota?: RoutingQuotaScore;
  eligible: boolean;
  eligibleRound: number;
  now: number;
  expires: number;
}
export const routingCompletionMs = (candidate: RoutingCandidate, load: number) =>
  (candidate.statistics?.completionMs ?? 0) +
  (candidate.statistics?.serviceMs ?? candidate.statistics?.completionMs ?? 0) * load;
export function routingReliabilityScore(candidate: RoutingCandidate): number[] {
  const ready = routingReady(candidate);
  return [
    Number(candidate.health === "degraded"),
    ready ? (candidate.statistics!.failureRate < 0.05 ? 0 : 2) : 1,
    ready ? Math.floor(candidate.statistics!.failureRate / 0.05) : 0,
  ];
}
export function routingScore(
  strategy: RoutingStrategy,
  candidate: RoutingCandidate,
  request: RoutingRequest,
  rank: {
    tier: number;
    pressure: number;
    load: number;
    concurrency?: number;
    quota?: RoutingQuotaScore;
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
    result.push(...routingReliabilityScore(candidate));
    result.push(
      ready
        ? Math.floor(Math.log1p(routingCompletionMs(candidate, rank.load)) / Math.log(1.15))
        : 0,
      ready && rank.pricesKnown ? (candidate.statistics!.marginalCost ?? 0) : 0,
    );
  }
  if (strategy === "expiry-first") {
    const benefit = routingExpiryBenefit(candidate, request, rank.now);
    result.push(-benefit, benefit > 0 ? candidate.expiry!.expiresAt : 0);
  }
  const quota = rank.quota;
  const pressure =
    strategy === "headroom-balance" && quota?.quality === 0
      ? quota.vector
      : [Math.floor(rank.pressure / 0.05)];
  const work = candidate.recentWork;
  // 同一时刻的衰减因子对所有路由相同；对数坐标让时间流逝不触发十万叶重排。
  const recent =
    work && work.units > 0
      ? Math.log2(work.units / 4096) + work.at / 3_600_000 - Math.log2(rank.concurrency ?? 2)
      : -Infinity;
  return [
    ...result,
    quota?.quality ?? (routingQuotaKnown(candidate, rank.now) ? 1 : 2),
    ...pressure,
    rank.load,
    recent,
    rank.index,
  ];
}
export function compareRoutingScore(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const difference = a[i]! - b[i]!;
    if (difference) return difference;
  }
  return a.length - b.length;
}
