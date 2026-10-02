import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";
import {
  ProjectMemoryChangeSchema,
  ProjectMemoryReviewSchema,
} from "../interfaces/project-memory.port.js";

export const MEMORY_SEARCH_TOOL_NAME = "MemorySearch";
export const MEMORY_REVIEW_TOOL_NAME = "MemoryReview";
export const MEMORY_HISTORY_TOOL_NAME = "MemoryHistory";
// 持久会话可能保留旧提案工具名；仅用于证据隔离，不再注册人工逐条应用工具。
export const MEMORY_REVIEW_APPLY_TOOL_NAME = "MemoryReviewApply";

const id = z.string().regex(/^[a-zA-Z0-9_-]{8,96}$/u);
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/u);

export const MemorySearchInputSchema = z
  .object({
    query: z.string().trim().min(1).max(4000),
  })
  .strict();

export const MemoryReviewInputSchema = z
  .object({
    action: z.enum(["create", "list", "read"]),
    query: z.string().trim().min(1).max(4000).optional(),
    proposalId: id.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.action === "create" && !input.query) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "create requires a focused query" });
    }
    if (input.action === "read" && !input.proposalId) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "read requires proposalId" });
    }
  });

export const MemoryHistoryInputSchema = z
  .object({
    action: z.enum(["list", "undo"]),
    changeId: id.optional(),
    expectedHash: hash.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.action === "undo" && (!input.changeId || !input.expectedHash)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "undo requires changeId and its current afterHash",
      });
    }
  });

export type MemoryReviewInput = z.infer<typeof MemoryReviewInputSchema>;
export type MemoryHistoryInput = z.infer<typeof MemoryHistoryInputSchema>;

const nonnegativeInteger = z.number().int().nonnegative();
export const MemorySearchOutputSchema = z
  .object({
    status: z.literal("ok"),
    attachment: z.string().optional(),
    candidateCount: nonnegativeInteger,
    indexedCount: nonnegativeInteger,
    matchCount: nonnegativeInteger,
    results: z
      .array(
        z
          .object({
            filePath: z.string(),
            filename: z.string(),
            mtimeMs: z.number().finite(),
            type: z.enum(["user", "feedback", "project", "reference"]).optional(),
            description: z.string().optional(),
            content: z.string(),
            score: z.number().finite().positive(),
            sourceHash: z.string().optional(),
            matchedTerms: z.array(z.string()).optional(),
            metadataMatches: z.array(z.string()).optional(),
          })
          .strict(),
      )
      .max(4),
    health: z
      .object({
        scanLimited: z.boolean(),
        failedFileCount: nonnegativeInteger,
        expiredCount: nonnegativeInteger,
        truncatedFileCount: nonnegativeInteger,
        indexedBytes: nonnegativeInteger,
      })
      .strict()
      .optional(),
    scan: z
      .object({
        complete: z.boolean(),
        truncated: z.boolean(),
        rejected: nonnegativeInteger,
        failedDirectories: nonnegativeInteger,
        scannedDirectories: nonnegativeInteger,
        processedEntries: nonnegativeInteger,
        unknownDirectories: nonnegativeInteger,
      })
      .strict()
      .optional(),
  })
  .strict();
export const MemorySearchOutputJsonSchema = toToolJsonSchema(MemorySearchOutputSchema);

export const MemoryReviewResultSchema = z
  .object({
    status: z.enum(["completed", "no-change"]),
    proposalId: id.optional(),
    appliedCount: z.number().int().nonnegative(),
    rejectedCount: z.number().int().nonnegative(),
    conflictCount: z.number().int().nonnegative(),
    skippedReason: z
      .enum(["history-full", "reviews-full", "preimages-full", "recovery-required"])
      .optional(),
  })
  .strict();
export const MemoryReviewOutputSchema = z.union([
  MemoryReviewResultSchema,
  z.object({ status: z.literal("proposal"), proposal: ProjectMemoryReviewSchema }).strict(),
  z
    .object({
      status: z.literal("list"),
      proposals: z
        .array(
          z
            .object({
              id,
              revision: z.number().int().positive(),
              createdAt: z.number().nonnegative(),
              itemCount: z.number().int().nonnegative(),
              appliedCount: z.number().int().nonnegative(),
              partial: z.boolean(),
              summary: z.string().max(4000),
            })
            .strict(),
        )
        .max(100),
    })
    .strict(),
]);
export const MemoryHistoryOutputSchema = z.union([
  z.object({ status: z.literal("committed"), change: ProjectMemoryChangeSchema }).strict(),
  z
    .object({ status: z.literal("list"), changes: z.array(ProjectMemoryChangeSchema).max(100) })
    .strict(),
]);
export const MemoryReviewOutputJsonSchema = toToolJsonSchema(MemoryReviewOutputSchema);
export const MemoryHistoryOutputJsonSchema = toToolJsonSchema(MemoryHistoryOutputSchema);
export const MemorySearchInputJsonSchema = toToolJsonSchema(MemorySearchInputSchema);
export const MemoryReviewInputJsonSchema = toToolJsonSchema(MemoryReviewInputSchema);
export const MemoryHistoryInputJsonSchema = toToolJsonSchema(MemoryHistoryInputSchema);
