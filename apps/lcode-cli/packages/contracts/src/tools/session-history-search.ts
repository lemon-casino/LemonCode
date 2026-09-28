// ============================================================
// SessionHistorySearch Tool - bounded discovery of prior workspace sessions
// ============================================================

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const SESSION_HISTORY_SEARCH_TOOL_NAME = "SessionHistorySearch";

export const SESSION_HISTORY_SEARCH_MIN_LIMIT = 1;
export const SESSION_HISTORY_SEARCH_MAX_LIMIT = 10;
export const SESSION_HISTORY_SEARCH_DEFAULT_LIMIT = 5;

export const SESSION_HISTORY_SEARCH_CANDIDATE_LIMIT = 20;
export const SESSION_HISTORY_SEARCH_SESSION_CHARACTER_LIMIT = 32_000;
export const SESSION_HISTORY_SEARCH_TOTAL_CHARACTER_LIMIT = 256_000;
export const SESSION_HISTORY_SEARCH_PREVIEW_CHARACTER_LIMIT = 1_200;
export const SESSION_HISTORY_SEARCH_TITLE_CHARACTER_LIMIT = 256;
export const SESSION_HISTORY_SEARCH_QUERY_MAX_LENGTH = 4_000;

const SessionHistorySearchQuerySchema = z
  .string()
  .trim()
  .min(1)
  .max(SESSION_HISTORY_SEARCH_QUERY_MAX_LENGTH);

export const SessionHistorySearchInputSchema = z
  .object({
    query: SessionHistorySearchQuerySchema.describe(
      "Focused natural-language or identifier query for prior workspace sessions.",
    ),
    limit: clampedLimit().describe(
      `Maximum number of matches to return (${SESSION_HISTORY_SEARCH_MIN_LIMIT}-${SESSION_HISTORY_SEARCH_MAX_LIMIT}, default ${SESSION_HISTORY_SEARCH_DEFAULT_LIMIT}).`,
    ),
  })
  .strict();

export type SessionHistorySearchInput = z.infer<typeof SessionHistorySearchInputSchema>;

export const SessionHistorySearchInputJsonSchema = toToolJsonSchema(
  SessionHistorySearchInputSchema,
);

export const SessionHistorySearchMatchSchema = z
  .object({
    sessionId: z.string().min(1),
    title: z.string().max(SESSION_HISTORY_SEARCH_TITLE_CHARACTER_LIMIT),
    updatedAt: z.number().int().nonnegative(),
    preview: z.string().max(SESSION_HISTORY_SEARCH_PREVIEW_CHARACTER_LIMIT),
    score: z.number().finite().positive(),
  })
  .strict();

export type SessionHistorySearchMatch = z.infer<typeof SessionHistorySearchMatchSchema>;

const SessionHistorySearchOkOutputSchema = z
  .object({
    status: z.literal("ok"),
    query: SessionHistorySearchQuerySchema,
    matches: z.array(SessionHistorySearchMatchSchema).max(SESSION_HISTORY_SEARCH_MAX_LIMIT),
    candidateSessionCount: z
      .number()
      .int()
      .nonnegative()
      .max(SESSION_HISTORY_SEARCH_CANDIDATE_LIMIT),
    scannedSessionCount: z.number().int().nonnegative(),
    scannedMessageCount: z.number().int().nonnegative(),
    projectedCharacterCount: z
      .number()
      .int()
      .nonnegative()
      .max(SESSION_HISTORY_SEARCH_TOTAL_CHARACTER_LIMIT),
    failedSessionCount: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })
  .strict();

export const SessionHistorySearchUnavailableReasonSchema = z.enum([
  "session_store_unavailable",
  "session_list_failed",
  "session_messages_failed",
]);

export type SessionHistorySearchUnavailableReason = z.infer<
  typeof SessionHistorySearchUnavailableReasonSchema
>;

const SessionHistorySearchUnavailableOutputSchemas = [
  z
    .object({
      status: z.literal("unavailable"),
      reason: z.literal("session_store_unavailable"),
      retryable: z.literal(false),
    })
    .strict(),
  z
    .object({
      status: z.literal("unavailable"),
      reason: z.literal("session_list_failed"),
      retryable: z.literal(true),
    })
    .strict(),
  z
    .object({
      status: z.literal("unavailable"),
      reason: z.literal("session_messages_failed"),
      retryable: z.literal(true),
    })
    .strict(),
] as const;

export const SessionHistorySearchOutputSchema = z.union([
  SessionHistorySearchOkOutputSchema,
  ...SessionHistorySearchUnavailableOutputSchemas,
]);

export type SessionHistorySearchOutput = z.infer<typeof SessionHistorySearchOutputSchema>;

export const SessionHistorySearchOutputJsonSchema = toToolJsonSchema(
  SessionHistorySearchOutputSchema,
);

function clampedLimit(): z.ZodEffects<z.ZodDefault<z.ZodNumber>, number, unknown> {
  return z.preprocess((value) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return value;
    return Math.min(
      SESSION_HISTORY_SEARCH_MAX_LIMIT,
      Math.max(SESSION_HISTORY_SEARCH_MIN_LIMIT, Math.trunc(value)),
    );
  }, z.number().int().min(SESSION_HISTORY_SEARCH_MIN_LIMIT).max(SESSION_HISTORY_SEARCH_MAX_LIMIT).default(SESSION_HISTORY_SEARCH_DEFAULT_LIMIT));
}
