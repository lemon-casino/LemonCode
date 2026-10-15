import { z } from "zod";

export const DEFAULT_TOKEN_USAGE_STATUS_BAR = {
  enabled: true,
  position: "inside",
  speed: true,
  context: true,
  session: true,
  cache: true,
  request: true,
  subagents: true,
  animations: true,
} as const;

export const tokenUsageStatusBarSettingsSchema = z
  .object({
    enabled: z.boolean().default(true),
    position: z.enum(["inside", "below", "above"]).default("inside"),
    speed: z.boolean().default(true),
    context: z.boolean().default(true),
    session: z.boolean().default(true),
    cache: z.boolean().default(true),
    request: z.boolean().default(true),
    subagents: z.boolean().default(true),
    animations: z.boolean().default(true),
  })
  .strict();

export type TokenUsageStatusBarSettings = z.infer<typeof tokenUsageStatusBarSettingsSchema>;
