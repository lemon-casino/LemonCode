import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const READ_SESSION_CONTEXT_TOOL_NAME = "ReadSessionContext";
export const READ_SESSION_CONTEXT_DEFAULT_MAX_TOKENS = 6000;
export const READ_SESSION_CONTEXT_MAX_TOKENS = 12000;

const SESSION_ID_PATTERN = /^sess_[A-Za-z0-9._-]+$/;

export const ReadSessionContextStrategySchema = z.enum(["relevant", "handoff"]);

export const ReadSessionContextInputSchema = z
  .object({
    sessionId: z
      .string()
      .regex(SESSION_ID_PATTERN, "Session id must use the sess_* format.")
      .describe("Target LCode session id to read from persisted session history."),
    query: z
      .string()
      .min(1)
      .max(4000)
      .describe(
        "Focused natural-language description of the context needed from the target session.",
      ),
    strategy: ReadSessionContextStrategySchema.optional()
      .default("relevant")
      .describe(
        "Use relevant for focused retrieval, or handoff for a bounded continuation summary.",
      ),
    maxTokens: z
      .number()
      .int()
      .positive()
      .max(READ_SESSION_CONTEXT_MAX_TOKENS)
      .optional()
      .describe("Approximate maximum tokens to return to the model."),
    persistCapsule: z
      .boolean()
      .optional()
      .describe(
        "Explicitly save this handoff summary as provenance for the current accepted user turn. Never saves another session's task state.",
      ),
    capsuleId: z
      .string()
      .regex(/^capsule_[a-f0-9]{32}$/)
      .optional()
      .describe(
        "Reuse a previously saved capsule belonging to the current target session; source scope and content are checked again.",
      ),
  })
  .strict()
  .refine(
    (input) => (!input.persistCapsule && !input.capsuleId) || input.strategy === "handoff",
    "Capsules require the handoff strategy.",
  )
  .refine(
    (input) => !(input.persistCapsule && input.capsuleId),
    "Read an existing capsule or generate a new one, not both.",
  );

export type ReadSessionContextInput = z.infer<typeof ReadSessionContextInputSchema>;

export const ReadSessionContextInputJsonSchema = toToolJsonSchema(ReadSessionContextInputSchema);

export const ReadSessionContextReferenceSchema = z
  .object({
    messageId: z.string(),
    partId: z.string().optional(),
    index: z.number().int().nonnegative().optional(),
    role: z.enum(["user", "assistant"]).optional(),
    reason: z.string().optional(),
  })
  .strict();

export type ReadSessionContextReference = z.infer<typeof ReadSessionContextReferenceSchema>;

export const ReadSessionContextOutputSchema = z
  .object({
    status: z.enum(["success", "not_found", "failed"]),
    sessionId: z.string(),
    title: z.string().optional(),
    directory: z.string().optional(),
    path: z.string().optional(),
    strategy: ReadSessionContextStrategySchema,
    query: z.string(),
    source: z.enum(["lite", "local", "fallback", "none", "capsule"]),
    content: z.string(),
    messageCount: z.number().int().nonnegative(),
    selectedMessageCount: z.number().int().nonnegative().optional(),
    truncated: z.boolean(),
    error: z.string().optional(),
    references: z.array(ReadSessionContextReferenceSchema).optional(),
    sourceVersion: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    sourceBoundaryMessageId: z.string().optional(),
    capsuleId: z
      .string()
      .regex(/^capsule_[a-f0-9]{32}$/)
      .optional(),
  })
  .strict();

export type ReadSessionContextOutput = z.infer<typeof ReadSessionContextOutputSchema>;

export const ReadSessionContextOutputJsonSchema = toToolJsonSchema(ReadSessionContextOutputSchema);
