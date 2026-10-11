import { z } from "zod";

export const CONTEXT_TREND_SAMPLE_LIMIT = 200;
export const contextTrendSampleSchema = z
  .object({
    id: z.string().min(1),
    timestamp: z.number().finite().nonnegative(),
    kind: z.enum(["request", "compact"]),
    usedTokens: z.number().finite().nonnegative(),
    maxTokens: z.number().finite().positive().nullable(),
    modelId: z.string().optional(),
    providerId: z.string().optional(),
    turnId: z.string().optional(),
    tokensBefore: z.number().finite().nonnegative().optional(),
  })
  .strict();
export type ContextTrendSample = z.infer<typeof contextTrendSampleSchema>;
export const contextTrendSchema = z
  .object({
    samples: z.array(contextTrendSampleSchema).max(CONTEXT_TREND_SAMPLE_LIMIT),
    truncated: z.boolean(),
  })
  .strict();
export type ContextTrend = z.infer<typeof contextTrendSchema>;

/** 持久化与实时事实共用稳定 ID；只保留最近样本，未知历史容量始终保留 null。 */
export function mergeContextTrend(
  current: ContextTrend | undefined,
  incoming: readonly ContextTrendSample[],
  truncated = false,
): ContextTrend {
  const byId = new Map((current?.samples ?? []).map((sample) => [sample.id, sample]));
  for (const sample of incoming) byId.set(sample.id, sample);
  const samples = [...byId.values()].sort(
    (a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id),
  );
  return {
    samples: samples.slice(-CONTEXT_TREND_SAMPLE_LIMIT),
    truncated: Boolean(
      current?.truncated || truncated || samples.length > CONTEXT_TREND_SAMPLE_LIMIT,
    ),
  };
}
