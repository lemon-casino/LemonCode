export interface RoutingCacheFacts {
  source: "upstream-contract";
  validUntil: number;
  groupId?: string;
  portability?: "portable" | "account-bound" | "provider-session-bound";
  switchCost?: { amount: number; unit: string };
}
/** 只消费明确的上游契约头；没有声明就没有跨轮 TTL、共享关系或重建成本。 */
export function readRoutingCacheFacts(
  headers: Pick<Headers, "get">,
  now: number,
): RoutingCacheFacts | undefined {
  const raw = headers.get("x-lcode-cache-ttl-ms");
  if (!raw || !/^\d+$/u.test(raw)) return;
  const ttl = Number(raw);
  if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > 86400000) return;
  const group = headers.get("x-lcode-cache-group")?.trim(),
    portability = headers.get("x-lcode-cache-portability");
  const amount = headers.get("x-lcode-cache-switch-cost"),
    unit = headers.get("x-lcode-cache-switch-unit")?.trim();
  return {
    source: "upstream-contract",
    validUntil: now + ttl,
    ...(group && group.length <= 256 ? { groupId: group } : {}),
    ...(portability === "portable" ||
    portability === "account-bound" ||
    portability === "provider-session-bound"
      ? { portability }
      : {}),
    ...(amount &&
    /^\d+(?:\.\d+)?$/u.test(amount) &&
    Number.isFinite(Number(amount)) &&
    unit &&
    unit.length <= 80
      ? { switchCost: { amount: Number(amount), unit } }
      : {}),
  };
}
