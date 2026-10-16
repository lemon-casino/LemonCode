import { routingDemand } from "@lcode/provider";
import type { SharedQuotaState } from "./api-key-shared-quota-state.js";

const UNITS = ["requests", "tokens", "input_tokens", "output_tokens"] as const;
/** 只折叠已知终态；仍未知的消费/在途绝不因时间过去而释放。 */
export function compactSharedQuota(state: SharedQuotaState, now: number): void {
  for (const [id, lease] of Object.entries(state.leases)) {
    if (lease.expiresAt > now || lease.state === "reserved" || lease.state === "dispatched")
      continue;
    if (lease.state === "cancelled" || lease.state === "expired") {
      delete state.leases[id];
      continue;
    }
    const watched = (lease.watched ?? Object.keys(lease.demands)).filter(
      (key) => state.resources[key]?.window.kind !== "informational",
    );
    const allCovered =
      watched.length > 0 &&
      watched.every((key) => lease.sequence <= state.resources[key]!.coveredThrough);
    if (!lease.feedbackComplete && !lease.notSent && !allCovered) continue;
    if (
      watched.some(
        (key) =>
          lease.sequence > state.resources[key]!.coveredThrough &&
          lease.actual[key] === undefined &&
          state.resources[key]!.window.unit !== "requests",
      )
    )
      continue;
    if (!watched.length && !lease.notSent && lease.actualTokens?.total === undefined) continue;
    for (const key of watched) {
      const resource = state.resources[key]!;
      if (lease.sequence <= resource.coveredThrough) continue;
      resource.folded = (resource.folded ?? 0) + (lease.actual[key] ?? lease.demands[key] ?? 1);
      resource.foldedThrough = Math.max(resource.foldedThrough ?? 0, lease.sequence);
    }
    if (!lease.notSent) {
      const unassigned = (state.unassigned ??= {});
      for (const unit of UNITS) {
        const observed = watched
          .filter((key) => state.resources[key]!.window.unit === unit)
          .map((key) => lease.actual[key])
          .filter((amount): amount is number => amount !== undefined);
        const normalized = routingDemand(undefined, "", unit, lease.actualTokens);
        const actual = observed.length ? Math.max(normalized ?? 0, ...observed) : normalized;
        const estimate =
          unit === "requests" || lease.tokens?.quality === "bound"
            ? routingDemand(undefined, "", unit, lease.tokens)
            : undefined;
        const bound =
          actual ??
          (lease.actualTokens?.total !== undefined && unit.includes("tokens")
            ? Math.min(estimate ?? Infinity, lease.actualTokens.total)
            : estimate);
        const prior = (unassigned[unit] ??= { amount: 0, through: 0, unknown: false });
        prior.amount += bound ?? 0;
        prior.unknown ||= bound === undefined;
        prior.through = Math.max(prior.through, lease.sequence);
      }
    }
    delete state.leases[id];
  }
  const used = new Set(Object.values(state.current));
  for (const lease of Object.values(state.leases))
    for (const key of lease.watched ?? Object.keys(lease.demands)) used.add(key);
  for (const key of Object.keys(state.resources)) if (!used.has(key)) delete state.resources[key];
}
