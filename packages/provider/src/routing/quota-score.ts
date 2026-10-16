import type {
  RoutingCandidate,
  RoutingRequest,
  RoutingQuotaScore,
} from "@lcode/shared/provider-routing";
import type { RoutingLedger } from "./ledger.js";
import { routingDemand } from "./values.js";
/** 百分比只证明局部压力；缺失窗口不能被当成零用量参与完整向量比较。 */
export function routingQuotaScore(
  candidate: RoutingCandidate,
  request: RoutingRequest,
  now: number,
  ledger: RoutingLedger,
): RoutingQuotaScore {
  const vector: number[] = [],
    dimensions: string[] = [];
  let count = 0,
    complete = 0,
    pressure = 0;
  for (const original of candidate.windows) {
    const window = ledger.reading(original);
    if (window.kind === "informational") continue;
    count++;
    if (
      window.quality !== "fresh" ||
      (window.resetAt !== undefined && window.resetAt <= now) ||
      (window.expiresAt !== undefined && window.expiresAt <= now)
    )
      continue;
    const left = ledger.available(window),
      demand = routingDemand(request.demands, window.resourceId, window.unit, request.tokens);
    const exact = left !== undefined && window.limit !== undefined && window.limit > 0;
    if (exact || window.usedPercent !== undefined) {
      const projected = exact
        ? 1 - left! / window.limit! + (demand ?? 0) / window.limit!
        : window.usedPercent! / 100;
      pressure = Math.max(pressure, projected);
      vector.push(Math.floor(projected / 0.05));
    }
    if (
      exact &&
      demand !== undefined &&
      (!window.unit?.includes("tokens") ||
        request.demands?.[window.resourceId] !== undefined ||
        request.tokens?.quality === "bound") &&
      window.kind !== "unknown"
    ) {
      complete++;
      dimensions.push(
        JSON.stringify([window.kind, window.unit ?? null, window.resetMode ?? "unknown"]),
      );
    }
  }
  return {
    quality: count > 0 && complete === count ? 0 : vector.length ? 1 : 2,
    dimensions: count > 0 && complete === count ? JSON.stringify(dimensions.sort()) : undefined,
    vector: vector.sort((a, b) => b - a),
    pressure,
  };
}
