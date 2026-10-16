import { z } from "zod";
import { apiKeyQuotaSnapshotSchema, providerRoutingPolicySchema } from "@lcode/shared";
import { RoutingError, routingDemand, type SharedQuotaView } from "@lcode/provider";
const amount = z.number().finite().nonnegative();
const identifier = z.string().min(1).max(256);
const counts = z.record(z.string(), amount);
const windowSchema = apiKeyQuotaSnapshotSchema.shape.windows.element.extend({
  resourceId: z.string().min(1).max(4096),
});
export const sharedWindowsSchema = z.array(windowSchema).max(100);
export const sharedInputSchema = z.strictObject({
  providerId: z.string().min(1),
  poolId: identifier,
  keyId: z.string().min(1),
  maxInFlight: z.number().int().min(1).max(1024),
  reserveRules: providerRoutingPolicySchema.shape.reserveRules,
  request: z.object({
    createdAt: amount,
    attemptId: z.string().min(1).max(8192),
    scopeKey: z.string().min(1).max(32768),
    modelKey: z.string().max(8192).optional(),
    tokens: z
      .strictObject({
        input: amount.optional(),
        output: amount.optional(),
        total: amount.optional(),
        quality: z.enum(["bound", "estimated"]),
      })
      .optional(),
    demands: counts.optional(),
  }),
  windows: sharedWindowsSchema,
});
export const sharedQuotaStateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sequence: z.number().int().nonnegative(),
  current: z.record(z.string(), z.string()),
  unassigned: z
    .record(z.string(), z.strictObject({ amount, through: amount, unknown: z.boolean() }))
    .optional(),
  resources: z.record(
    z.string(),
    z.strictObject({
      window: windowSchema,
      coveredThrough: z.number().int().nonnegative(),
      folded: amount.optional(),
      foldedThrough: amount.optional(),
      foldedUnknown: z.boolean().optional(),
    }),
  ),
  leases: z.record(
    z.string(),
    z.strictObject({
      clientId: identifier,
      fingerprint: identifier,
      fence: identifier,
      sequence: z.number().int().positive(),
      expiresAt: amount,
      keyId: identifier,
      state: z.enum(["reserved", "dispatched", "ended", "cancelled", "expired"]),
      demands: counts,
      actual: counts,
      tokens: sharedInputSchema.shape.request.shape.tokens,
      actualTokens: z
        .strictObject({
          input: amount.optional(),
          output: amount.optional(),
          total: amount.optional(),
        })
        .optional(),
      requested: counts.optional(),
      rules: providerRoutingPolicySchema.shape.reserveRules,
      watched: z.array(z.string()).max(4096).optional(),
      notSent: z.boolean().optional(),
      feedbackComplete: z.boolean().optional(),
    }),
  ),
});
export type SharedQuotaState = z.infer<typeof sharedQuotaStateSchema>;
export const emptySharedQuotaState = (): SharedQuotaState => ({
  schemaVersion: 1,
  sequence: 0,
  current: {},
  resources: {},
  leases: {},
});
export const resourceKey = (window: { resourceId: string; instanceId: string }) =>
  JSON.stringify([window.resourceId, window.instanceId]);
export function expireUnsent(state: SharedQuotaState, now: number): void {
  for (const lease of Object.values(state.leases))
    if (lease.state === "reserved" && lease.expiresAt <= now) lease.state = "expired";
}
export function sharedHeld(state: SharedQuotaState, key: string): number {
  const covered = state.resources[key]?.coveredThrough ?? 0;
  const resource = state.resources[key];
  let total =
    (resource?.foldedThrough ?? 0) <= covered
      ? 0
      : resource?.foldedUnknown
        ? Math.max(resource.window.remaining ?? 0, resource.folded ?? 0)
        : (resource?.folded ?? 0);
  for (const lease of Object.values(state.leases)) {
    if (lease.state === "cancelled" || lease.state === "expired") continue;
    if (lease.state === "ended" && lease.sequence <= covered) continue;
    total +=
      lease.state === "ended"
        ? (lease.actual[key] ?? lease.demands[key] ?? 0)
        : (lease.demands[key] ?? 0);
  }
  return total;
}
export function mergeSharedWindows(
  state: SharedQuotaState,
  windows: z.infer<typeof windowSchema>[],
  coverage?: number,
): void {
  if (
    coverage !== undefined &&
    (!Number.isSafeInteger(coverage) || coverage < 0 || coverage > state.sequence)
  )
    throw new RoutingError("owner-stale");
  for (const input of windows) {
    const key = resourceKey(input),
      previous = state.resources[key];
    if (previous && previous.window.unit !== input.unit) throw new RoutingError("owner-stale");
    const currentKey = JSON.stringify(input.resourceId);
    const active = state.current[currentKey];
    const activeWindow = active ? state.resources[active]?.window : undefined;
    // 覆盖水位不是账期时序，旧账期即使带覆盖证明也不能重新成为 current。
    if (
      !active ||
      active === key ||
      (input.resetMode === "fixed" &&
        input.resetAt !== undefined &&
        input.resetAt > (activeWindow?.resetAt ?? Infinity))
    )
      state.current[currentKey] = key;
    const { coversThroughSeq: _localWatermark, ...window } = input;
    if (coverage !== undefined && coverage < (previous?.coveredThrough ?? 0))
      throw new RoutingError("owner-stale");
    const remaining =
      coverage !== undefined && coverage > (previous?.coveredThrough ?? 0)
        ? window.remaining
        : previous?.window.remaining === undefined
          ? window.remaining
          : window.remaining === undefined
            ? previous.window.remaining
            : Math.min(previous.window.remaining, window.remaining);
    const blind = !active ? state.unassigned?.[window.unit ?? ""] : undefined;
    const foldedThrough = previous?.foldedThrough ?? blind?.through ?? 0;
    const coveredThrough = Math.max(previous?.coveredThrough ?? 0, coverage ?? 0);
    state.resources[key] = {
      folded: coveredThrough >= foldedThrough ? 0 : (previous?.folded ?? blind?.amount ?? 0),
      foldedUnknown:
        coveredThrough >= foldedThrough
          ? false
          : (previous?.foldedUnknown ?? blind?.unknown ?? false),
      foldedThrough,
      window: { ...window, ...(remaining !== undefined ? { remaining } : {}) },
      coveredThrough: Math.max(previous?.coveredThrough ?? 0, coverage ?? 0),
    };
    if (window.kind === "informational") continue;
    // 响应头新增窗口也必须约束原在途请求；否则先用空快照派发可漏掉整笔消费。
    for (const lease of Object.values(state.leases)) {
      if (lease.state === "cancelled" || lease.state === "expired") continue;
      const watched = (lease.watched ??= Object.keys(lease.demands));
      if (
        (lease.state === "reserved" ||
          lease.state === "dispatched" ||
          (!active && lease.state === "ended")) &&
        !watched.includes(key)
      )
        watched.push(key);
      if (!watched.includes(key)) continue;
      if (!Object.hasOwn(lease.demands, key)) {
        const demand =
          window.unit?.includes("tokens") && lease.tokens?.quality !== "bound"
            ? undefined
            : routingDemand(lease.requested, window.resourceId, window.unit, lease.tokens);
        if (demand !== undefined || remaining !== undefined)
          lease.demands[key] = demand ?? remaining!;
      }
      const actual = lease.notSent
        ? 0
        : routingDemand(undefined, window.resourceId, window.unit, lease.actualTokens);
      if (actual !== undefined && !Object.hasOwn(lease.actual, key)) lease.actual[key] = actual;
    }
  }
}
export function sharedQuotaView(state: SharedQuotaState, capacity: number): SharedQuotaView {
  const leases = Object.values(state.leases);
  return {
    source: "shared-owner",
    sequence: state.sequence,
    inFlight: leases.filter((l) => l.state === "dispatched").length,
    reservations: leases.filter((l) => l.state === "reserved" || l.state === "dispatched").length,
    retainedAttempts: leases.length,
    capacity,
    resources: Object.entries(state.resources).map(([key, resource]) => {
      const held = sharedHeld(state, key);
      return {
        resourceId: resource.window.resourceId,
        instanceId: resource.window.instanceId,
        held,
        available:
          resource.window.remaining === undefined
            ? undefined
            : Math.max(0, resource.window.remaining - held),
      };
    }),
  };
}
