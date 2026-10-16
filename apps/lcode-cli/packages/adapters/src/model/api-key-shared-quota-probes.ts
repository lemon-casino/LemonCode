import { RoutingError, type RoutingWindow } from "@lcode/provider";
import type { SharedQuotaState } from "./api-key-shared-quota-state.js";
export function sharedNeedsProbe(window: RoutingWindow, now: number) {
  return (
    window.kind !== "informational" &&
    (window.quality !== "fresh" ||
      (window.resetAt !== undefined && window.resetAt <= now) ||
      (window.remaining === undefined && window.usedPercent === undefined))
  );
}
/** reset 到时只允许取一次新事实；派发后的探测不能因流结束、TTL 或进程退出释放。 */
export function claimSharedProbe(
  state: SharedQuotaState,
  window: RoutingWindow,
  leaseId: string,
  now: number,
  unknownDemand = false,
) {
  const probes = (state.quotaProbes ??= {}),
    old = probes[window.resourceId];
  if (
    old &&
    window.quality === "fresh" &&
    (window.resetAt === undefined || window.resetAt > now) &&
    (window.revision > old.revision || window.instanceId !== old.instanceId)
  )
    delete probes[window.resourceId];
  if (!sharedNeedsProbe(window, now) && !unknownDemand) return false;
  if (probes[window.resourceId] && probes[window.resourceId]!.leaseId !== leaseId)
    throw new RoutingError("reserve-unverifiable", { scope: "pool", phase: "admission" });
  probes[window.resourceId] ??= {
    leaseId,
    revision: window.revision,
    instanceId: window.instanceId,
    dispatched: false,
  };
  return true;
}
export function cancelSharedProbes(state: SharedQuotaState, leaseId: string) {
  for (const [resource, probe] of Object.entries(state.quotaProbes ?? {}))
    if (probe.leaseId === leaseId && !probe.dispatched) delete state.quotaProbes![resource];
}
