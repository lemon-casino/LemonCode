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
export const routingFailureCodeSchema = z.enum([
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
}
export interface RoutingCandidate {
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
  attemptId: string;
  scopeKey: string;
  turnId?: string;
  workUnits?: number;
  demands?: Readonly<Record<string, number>>;
  signal?: AbortSignal;
  deadline?: number;
}
export interface RoutingFinish {
  replaySafeFailure?: boolean;
  actualDemands?: Readonly<Record<string, number>>;
  workUnits?: number;
  cacheUntil?: number;
  outcome?: "success" | "failed" | "cancelled" | "unknown";
}
export interface RoutingPlan {
  revision: number;
  routes: string[];
  effectiveStrategy: RoutingStrategy;
  fallbackReason?: string;
  excluded: Readonly<Record<string, string>>;
  available: Readonly<Record<string, number>>;
  pressures: Readonly<Record<string, number>>;
  reason: string;
}
