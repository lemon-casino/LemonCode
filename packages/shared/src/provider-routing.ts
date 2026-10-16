import { z } from "zod";

export const routingStrategySchema = z.enum([
  "reliable-first",
  "primary-backup",
  "share-rotation",
  "headroom-balance",
  "expiry-first",
]);
const routeId = z.string().min(1).max(256);
export const providerRoutingPolicySchema = z
  .object({
    version: z.literal(1),
    strategy: routingStrategySchema,
    order: z.array(routeId).max(100_000).optional(),
    weights: z.record(routeId, z.number().int().min(1).max(100)).optional(),
    maxInFlightPerCandidate: z.number().int().min(1).max(64).optional(),
    cacheMode: z.enum(["auto", "turn-only"]).optional(),
    reserveRules: z
      .array(
        z
          .object({
            resourceId: routeId,
            mode: z.enum(["soft", "hard"]),
            minRemainingPercent: z.number().finite().min(0).max(100),
          })
          .strict(),
      )
      .max(100)
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.order && new Set(value.order).size !== value.order.length)
      context.addIssue({ code: "custom", path: ["order"], message: "Duplicate route IDs" });
    const rules = value.reserveRules?.map((rule) => rule.resourceId) ?? [];
    if (new Set(rules).size !== rules.length)
      context.addIssue({
        code: "custom",
        path: ["reserveRules"],
        message: "Duplicate reserve rules",
      });
  });
export type RoutingStrategy = z.infer<typeof routingStrategySchema>;
export const apiKeyRoutingMetadataSchema = z.strictObject({
  weight: z.number().int().min(1).max(100).optional(),
  priority: z.number().int().min(-1_000_000).max(1_000_000).optional(),
  quotaPoolId: routeId.optional(),
  cacheGroupId: routeId.optional(),
  cacheTtlMs: z.number().int().positive().max(86_400_000).optional(),
});
export type ApiKeyRoutingMetadata = z.infer<typeof apiKeyRoutingMetadataSchema>;
export const setApiKeyRoutingMetadataSchema = z.strictObject({
  providerId: routeId,
  expectedRevision: z.number().int().nonnegative(),
  target: z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("all") }),
    z.strictObject({
      type: z.literal("ids"),
      keyIds: z
        .array(routeId)
        .min(1)
        .max(100_000)
        .refine((ids) => new Set(ids).size === ids.length, "Duplicate key IDs"),
    }),
  ]),
  patch: z
    .strictObject({
      quotaPoolId: routeId.nullable().optional(),
      cacheGroupId: routeId.nullable().optional(),
      cacheTtlMs: z.number().int().positive().max(86_400_000).nullable().optional(),
      weight: z.number().int().min(1).max(100).nullable().optional(),
      priority: z.number().int().min(-1_000_000).max(1_000_000).nullable().optional(),
    })
    .refine((patch) => Object.keys(patch).length > 0, "Empty metadata patch")
    .nullable(),
});
export type SetApiKeyRoutingMetadata = z.infer<typeof setApiKeyRoutingMetadataSchema>;
export const readApiKeyRoutingPageSchema = z.strictObject({
  providerId: routeId,
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(100).default(50),
  expectedRevision: z.number().int().nonnegative().optional(),
});
export type ReadApiKeyRoutingPage = z.input<typeof readApiKeyRoutingPageSchema>;
export interface ApiKeyRoutingPage {
  source: "configuration";
  revision: number;
  total: number;
  offset: number;
  nextOffset?: number;
  summary: { enabled: number; sharedPools: number; cacheGroups: number };
  rows: { id: string; enabled: boolean; routing?: ApiKeyRoutingMetadata; issues: string[] }[];
}
export const apiKeyQuotaSnapshotSchema = z
  .strictObject({
    keyId: routeId.optional(),
    poolId: routeId.optional(),
    windows: z
      .array(
        z.strictObject({
          resourceId: routeId,
          instanceId: routeId,
          revision: z.number().int().nonnegative(),
          kind: z.enum(["rate", "budget", "expiring-balance", "informational", "unknown"]),
          quality: z.enum(["fresh", "stale", "partial", "unknown"]),
          remaining: z.number().finite().nonnegative().optional(),
          limit: z.number().finite().positive().optional(),
          usedPercent: z.number().finite().min(0).max(100).optional(),
          unit: z.string().min(1).max(80).optional(),
          resetAt: z.number().finite().nonnegative().optional(),
          expiresAt: z.number().finite().nonnegative().optional(),
          coversThroughSeq: z.number().int().nonnegative().optional(),
          stableId: z.boolean().optional(),
          resetMode: z.enum(["fixed", "rolling", "none", "unknown"]).optional(),
        }),
      )
      .max(100),
  })
  .refine((value) => Boolean(value.keyId) !== Boolean(value.poolId), "One quota owner is required");
export type ApiKeyQuotaSnapshot = z.infer<typeof apiKeyQuotaSnapshotSchema>;
export const routingFailureCodeSchema = z.enum([
  "quota-owner-unavailable",
  "quota-owner-capacity",
  "no-compatible-route",
  "binding-blocked",
  "quota-exhausted",
  "route-cooling",
  "concurrency-full",
  "reserve-unverifiable",
  "policy-conflict",
  "routing-capability-required",
  "attempt-budget-exhausted",
  "owner-stale",
  "dispatch-uncertain",
  "attempt-conflict",
  "attempt-expired",
  "invalid-work-estimate",
  "invalid-usage",
  "attempt-already-dispatched",
]);
export type RoutingFailureCode = z.infer<typeof routingFailureCodeSchema>;
export type ProviderRoutingPolicy = z.infer<typeof providerRoutingPolicySchema>;
export const setProviderRoutingSchema = z
  .object({
    providerId: routeId,
    expectedRevision: z.number().int().nonnegative(),
    routing: providerRoutingPolicySchema.nullable(),
  })
  .strict();
export type SetProviderRouting = z.infer<typeof setProviderRoutingSchema>;
export const routingInvocationSchema = z
  .object({
    capability: z.literal("single-attempt-routing-v1"),
    workspaceKey: z.string().min(1).max(8192),
    sessionId: z.string().min(1).max(4096),
    attemptId: z.string().min(1).max(4096),
    turnId: z.string().min(1).max(4096).optional(),
    executionId: z.string().min(1).max(4096).optional(),
    actorId: z.string().min(1).max(4096).optional(),
    invocationId: z.string().min(1).max(4096).optional(),
    remoteSessionId: z.string().min(1).max(4096).optional(),
  })
  .strict();
export type RoutingInvocation = z.infer<typeof routingInvocationSchema>;
export const routingUsageSchema = z
  .object({
    outcome: z.enum(["success", "failed", "cancelled"]).optional(),
    replaySafeFailure: z.boolean().optional(),
    statusCode: z.number().int().min(400).max(599).optional(),
    retryAfterMs: z.number().finite().nonnegative().max(86400000).optional(),
    rateLimitScope: z.enum(["key", "shared"]).optional(),
    workUnits: z.number().finite().nonnegative().optional(),
    inputTokens: z.number().finite().nonnegative().optional(),
    outputTokens: z.number().finite().nonnegative().optional(),
  })
  .strict();
export type RoutingUsage = z.infer<typeof routingUsageSchema>;

export interface RoutingWindow {
  resourceId: string;
  instanceId: string;
  revision: number;
  kind: "rate" | "budget" | "expiring-balance" | "informational" | "unknown";
  quality: "fresh" | "stale" | "partial" | "unknown";
  remaining?: number;
  limit?: number;
  usedPercent?: number;
  unit?: string;
  resetAt?: number;
  expiresAt?: number;
  coversThroughSeq?: number;
  stableId?: boolean;
  resetMode?: "fixed" | "rolling" | "none" | "unknown";
  shared?: boolean;
  /** 共享借记由外部 owner 持有，本地只投影读数。 */
  coordinated?: boolean;
}
export interface RoutingCandidate {
  quotaGroupId?: string;
  cacheGroupId?: string;
  id: string;
  generation: string;
  windows: RoutingWindow[];
  portability: "portable" | "account-bound" | "provider-session-bound" | "unknown";
  unavailable?: string;
  maxInFlight?: number;
  health?: "healthy" | "degraded" | "open";
  statistics?: {
    samples: number;
    failureRate: number;
    completionMs: number;
    marginalCost?: number;
    currency?: string;
  };
  expiry?: {
    resourceId?: string;
    expiresAt: number;
    predictedWaste: number;
    comparableUnit: string;
    confidence: "estimated";
  };
}
export interface RoutingRequest {
  modelKey?: string;
  attemptId: string;
  scopeKey: string;
  turnId?: string;
  workUnits?: number;
  tokens?: RoutingTokens & { quality: "bound" | "estimated" };
  demands?: Readonly<Record<string, number>>;
  signal?: AbortSignal;
  deadline?: number;
}
export interface RoutingFinish {
  tokens?: RoutingTokens;
  replaySafeFailure?: boolean;
  actualDemands?: Readonly<Record<string, number>>;
  workUnits?: number;
  cacheUntil?: number;
  outcome?: "success" | "failed" | "cancelled" | "unknown";
}
export interface RoutingTokens {
  input?: number;
  output?: number;
  total?: number;
}
export interface RoutingPlan {
  tiers?: Readonly<Record<string, number>>;
  revision: number;
  routes: string[];
  effectiveStrategy: RoutingStrategy;
  fallbackReason?: string;
  excluded: Readonly<Record<string, string>>;
  available: Readonly<Record<string, number>>;
  pressures: Readonly<Record<string, number>>;
  reason: string;
}
