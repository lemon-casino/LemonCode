import { RoutingRecovery, type SharedQuotaView } from "@lcode/provider";
import type { SharedQuotaState } from "./api-key-shared-quota-state.js";

/** 在同一文件锁快照内分解借记；诊断不推进水位或更改恢复许可。 */
export function sharedQuotaView(
  state: SharedQuotaState,
  capacity: number,
  now: number,
): SharedQuotaView {
  const leases = Object.values(state.leases);
  const entries = Object.entries(state.resources);
  return {
    source: "shared-owner",
    asOf: now,
    sequence: state.sequence,
    inFlight: leases.filter((l) => l.state === "dispatched").length,
    reservations: leases.filter((l) => l.state === "reserved" || l.state === "dispatched").length,
    retainedAttempts: leases.length,
    capacity,
    recovery: new RoutingRecovery(state.recovery).inspect(now),
    resourceCount: entries.length,
    resourcesTruncated: entries.length > 100,
    resources: entries.slice(0, 100).map(([key, resource]) => {
      const { window, coveredThrough } = resource;
      let reserved = 0,
        dispatched = 0,
        endedActual = 0,
        endedEstimated = 0;
      for (const lease of leases) {
        if (lease.state === "reserved") reserved += lease.demands[key] ?? 0;
        else if (lease.state === "dispatched") dispatched += lease.demands[key] ?? 0;
        else if (lease.state === "ended" && lease.sequence > coveredThrough) {
          if (lease.actual[key] !== undefined) endedActual += lease.actual[key]!;
          else endedEstimated += lease.demands[key] ?? 0;
        }
      }
      const folded =
        (resource.foldedThrough ?? 0) <= coveredThrough
          ? 0
          : resource.foldedUnknown
            ? Math.max(window.remaining ?? 0, resource.folded ?? 0)
            : (resource.folded ?? 0);
      const held = reserved + dispatched + endedActual + endedEstimated + folded;
      return {
        resourceId: window.resourceId,
        instanceId: window.instanceId,
        current: state.current[JSON.stringify(window.resourceId)] === key,
        readingRemaining: window.remaining,
        limit: window.limit,
        unit: window.unit,
        quality: window.quality,
        coveredThroughSeq: coveredThrough,
        reserved,
        dispatched,
        endedActual,
        endedEstimated,
        folded,
        foldedUnknown: Boolean(resource.foldedUnknown && folded > 0),
        held,
        available:
          window.remaining === undefined ? undefined : Math.max(0, window.remaining - held),
      };
    }),
  };
}
