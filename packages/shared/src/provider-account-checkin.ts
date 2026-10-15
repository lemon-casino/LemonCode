import { z } from "zod";

export const providerCheckinOutcomeSchema = z.enum([
  "claimed",
  "done",
  "inactive",
  "ineligible",
  "own-app",
  "captcha",
  "failed",
  "unsupported",
]);
export const providerCheckinReplySchema = z
  .object({
    outcome: providerCheckinOutcomeSchema,
    credit: z.number().finite().nonnegative().optional(),
    streak: z.number().int().nonnegative().optional(),
    validUntil: z.string().datetime({ offset: true }).optional(),
    error: z
      .enum(["request_failed", "sign_in_required", "partial", "dependency_required"])
      .optional(),
  })
  .strict();
export const providerAccountCheckinResultSchema = providerCheckinReplySchema
  .extend({
    at: z.string().datetime({ offset: true }),
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .strict();
export const providerAccountCheckinStateSchema = z
  .object({
    automatic: z.boolean(),
    result: providerAccountCheckinResultSchema.optional(),
  })
  .strict();
export type ProviderCheckinReply = z.infer<typeof providerCheckinReplySchema>;
export type ProviderAccountCheckinResult = z.infer<typeof providerAccountCheckinResultSchema>;
export type ProviderAccountCheckinState = z.infer<typeof providerAccountCheckinStateSchema>;

export function providerCheckinDay(now: number): string {
  return new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
}
