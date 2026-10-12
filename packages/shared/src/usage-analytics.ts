import { z } from "zod";

const count = z.number().int().nonnegative();
const duration = z.number().finite().nonnegative().nullable();
export const PROVIDER_USAGE_RANGES = ["all", "24h", "7d", "30d"] as const;
export const providerUsageRequestSchema = z
  .object({
    range: z.enum(PROVIDER_USAGE_RANGES),
    timeZone: z.string().max(100).optional(),
    providerId: z.string().min(1).max(200).optional(),
    connectionId: z.string().uuid().nullable().optional(),
    modelId: z.string().min(1).max(300).optional(),
    offset: count.max(100000).default(0),
    limit: count.min(1).max(100).default(50),
  })
  .strict();
export type ProviderUsageRequest = z.input<typeof providerUsageRequestSchema>;

export const providerUsageMetricsSchema = z
  .object({
    requestCount: count,
    successCount: count,
    errorCount: count,
    cancelledCount: count,
    retryCount: count,
    knownUsageRequests: count,
    totalTokens: count,
    inputTokens: count,
    outputTokens: count,
    reasoningTokens: count,
    cacheReadTokens: count,
    cacheWriteTokens: count,
    cacheWriteKnownRequests: count.optional(),
    cacheHitRate: z.number().finite().min(0).max(1).nullable(),
    avgTimeToFirstTokenMs: duration,
    avgDurationMs: duration,
  })
  .strict();
export type ProviderUsageMetrics = z.infer<typeof providerUsageMetricsSchema>;

const identity = {
  providerId: z.string(),
  authChannelId: z.string().nullable(),
  accountConnectionId: z.string().uuid().nullable(),
};
export const providerUsageGroupSchema = providerUsageMetricsSchema
  .extend({
    ...identity,
    modelId: z.string().nullable(),
  })
  .strict();
export type ProviderUsageGroup = z.infer<typeof providerUsageGroupSchema>;
export const providerUsageRequestRecordSchema = z
  .object({
    ...identity,
    id: z.string(),
    sessionId: z.string(),
    modelId: z.string(),
    querySource: z.string(),
    status: z.enum(["completed", "error", "cancelled"]),
    startedAt: count,
    durationMs: duration,
    timeToFirstTokenMs: duration,
    totalTokens: count.nullable(),
    inputTokens: count.nullable(),
    outputTokens: count.nullable(),
    retryCount: count,
    errorCode: z.string().nullable(),
  })
  .strict();
export type ProviderUsageRequestRecord = z.infer<typeof providerUsageRequestRecordSchema>;

export const providerUsageActivitySchema = z
  .object({
    peakDayTokens: count,
    longestSessionMs: duration,
    currentStreakDays: count,
    longestStreakDays: count,
    activeDays: count,
    dailyTruncated: z.boolean(),
  })
  .strict();
export type ProviderUsageActivity = z.infer<typeof providerUsageActivitySchema>;

export const providerUsageSnapshotSchema = z
  .object({
    source: z.literal("agent-db"),
    range: z.enum(PROVIDER_USAGE_RANGES),
    generatedAt: count,
    since: count,
    until: count,
    timeZone: z.string(),
    retentionDays: z.literal(30),
    summary: providerUsageMetricsSchema,
    activity: providerUsageActivitySchema.optional(),
    dailyModels: z.array(providerUsageGroupSchema.extend({ date: z.string() }).strict()).optional(),
    daily: z.array(providerUsageMetricsSchema.extend({ date: z.string() }).strict()),
    providers: z.array(providerUsageGroupSchema),
    accounts: z.array(providerUsageGroupSchema),
    models: z.array(providerUsageGroupSchema),
    requests: z.array(providerUsageRequestRecordSchema),
    totalRequests: count,
    offset: count,
    limit: count,
  })
  .strict();
export type ProviderUsageSnapshot = z.infer<typeof providerUsageSnapshotSchema>;
