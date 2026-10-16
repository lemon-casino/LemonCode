import { RoutingError, type ProviderRoutingPolicy, type RoutingWindow } from "@lcode/provider";

/** reserve 与 dispatch 共用同一硬门；派发前的新读数不能绕过先前保留线。 */
export function assertSharedWindow(input: {
  window: RoutingWindow;
  demand?: number;
  held: number;
  own?: number;
  now: number;
  quality?: "bound" | "estimated";
  rules?: ProviderRoutingPolicy["reserveRules"];
  probe?: boolean;
}): void {
  const { window, demand, held, own = 0, now, quality, rules } = input;
  if (window.kind === "informational") return;
  if (window.expiresAt !== undefined && window.expiresAt <= now)
    throw new RoutingError("quota-exhausted");
  if (
    input.probe &&
    !rules?.some((rule) => rule.mode === "hard" && rule.resourceId === window.resourceId)
  )
    return;
  const left = window.remaining === undefined ? undefined : window.remaining - held + own;
  if (
    (window.quality === "fresh" && window.usedPercent === 100) ||
    (left !== undefined && left <= 0)
  )
    throw new RoutingError("quota-exhausted");
  if (
    left === undefined ||
    demand === undefined ||
    window.kind === "unknown" ||
    window.stableId === false ||
    window.quality !== "fresh" ||
    (window.unit?.includes("tokens") && quality === "estimated") ||
    (window.resetAt !== undefined && window.resetAt <= now) ||
    (window.expiresAt !== undefined && window.expiresAt <= now)
  )
    throw new RoutingError("reserve-unverifiable");
  if (demand > left) throw new RoutingError("quota-exhausted");
  const rule = rules?.find((rule) => rule.resourceId === window.resourceId && rule.mode === "hard");
  if (rule) {
    if (window.limit === undefined) throw new RoutingError("reserve-unverifiable");
    if (((left - demand) / window.limit) * 100 < rule.minRemainingPercent)
      throw new RoutingError("quota-exhausted");
  }
}
