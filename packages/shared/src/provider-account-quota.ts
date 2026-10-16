import { z } from "zod";

const finiteCount = z.number().finite().nonnegative();
const timestamp = z.string().datetime();
export const providerAccountQuotaWindowSchema = z
  .object({
    id: z.string().min(1).max(200),
    name: z.string().min(1).max(160),
    usedPercent: finiteCount.max(100).optional(),
    remainingPercent: finiteCount.max(100).optional(),
    used: finiteCount.optional(),
    remaining: finiteCount.optional(),
    limit: finiteCount.optional(),
    unit: z.string().max(40).optional(),
    resetAt: timestamp.optional(),
    expiresAt: timestamp.optional(),
    unlimited: z.boolean().optional(),
    display: z.string().max(160).optional(),
    modelId: z.string().max(160).optional(),
    pool: z.string().max(160).optional(),
    kind: z.enum(["rate", "budget", "expiring-balance", "informational", "unknown"]).optional(),
    instanceId: z.string().min(1).max(256).optional(),
    stableId: z.boolean().optional(),
    quotaPoolId: z.string().min(1).max(256).optional(),
    scope: z.enum(["account", "organization", "model", "shared", "unknown"]).optional(),
    resetMode: z.enum(["fixed", "rolling", "none", "unknown"]).optional(),
    includedModelIds: z.array(z.string().min(1).max(256)).max(100).optional(),
    excludedModelIds: z.array(z.string().min(1).max(256)).max(100).optional(),
  })
  .strict();
export const providerAccountQuotaSchema = z
  .object({
    connectionId: z.string().min(1),
    channelId: z.string().optional(),
    source: z.literal("upstream"),
    status: z.enum(["ready", "unknown", "unsupported", "error", "disabled", "removed"]),
    windows: z.array(providerAccountQuotaWindowSchema).max(100),
    stale: z.boolean(),
    partial: z.boolean().optional(),
    // checkedAt belongs to the last successful reading, not a failed refresh or cache hit.
    checkedAt: timestamp.optional(),
    attemptedAt: timestamp.optional(),
    plan: z.string().max(160).optional(),
    planExpiresAt: timestamp.optional(),
    renewal: z.enum(["auto", "off"]).optional(),
    balance: z.string().max(160).optional(),
    error: z
      .enum(["request_failed", "invalid_response", "account_changed", "service_closed"])
      .optional(),
  })
  .strict();
export type ProviderAccountQuotaWindow = z.infer<typeof providerAccountQuotaWindowSchema>;
export type ProviderAccountQuota = z.infer<typeof providerAccountQuotaSchema>;
