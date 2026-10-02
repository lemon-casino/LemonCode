import { z } from "zod";
import type { TraceContext } from "../tracing/tracer.js";

export const PROJECT_MEMORY_FILE_MAX_BYTES = 256 * 1024;
export const PROJECT_MEMORY_RECORD_MAX_BYTES = 1024 * 1024;
export const PROJECT_MEMORY_RECORD_LIMIT = 100;
export const PROJECT_MEMORY_PREIMAGES_MAX_BYTES = 20 * 1024 * 1024;
export const PROJECT_MEMORY_REVIEW_ITEM_LIMIT = 10;
export const PROJECT_MEMORY_REVIEW_TOTAL_CHARACTERS = 64_000;

const recordId = z.string().regex(/^[a-zA-Z0-9_-]{8,96}$/u);
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const relativeMarkdownPath = z
  .string()
  .min(1)
  .max(240)
  .refine(
    (value) =>
      value.endsWith(".md") &&
      !value.includes("\\") &&
      !value.includes(":") &&
      !Array.from(value).some((character) => character.charCodeAt(0) < 32) &&
      value.split("/").every((part) => part.length > 0 && part !== "." && part !== ".."),
    "Expected a contained relative Markdown path",
  );

export const ProjectMemoryReviewSourceSchema = z
  .object({
    id: z.string().min(1).max(128),
    kind: z.enum(["session", "memory"]),
    reference: z.string().min(1).max(256),
    revision: z.string().min(1).max(256),
    boundaryMessageId: z.string().min(1).max(256).optional(),
    projection: z.literal("latest-turn").optional(),
  })
  .strict()
  .superRefine((source, context) => {
    if (
      source.kind !== "session" &&
      (source.boundaryMessageId !== undefined || source.projection !== undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Only session evidence has a message boundary",
      });
    }
    if (source.projection && !source.boundaryMessageId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Latest-turn evidence requires a fixed end boundary",
      });
    }
  });

export const ProjectMemoryReviewItemSchema = z
  .object({
    id: recordId,
    fileName: relativeMarkdownPath,
    expectedHash: hash.nullable(),
    content: z.string().min(1).max(PROJECT_MEMORY_REVIEW_TOTAL_CHARACTERS),
    reason: z.string().min(1).max(2000),
    sourceIds: z.array(z.string().min(1).max(128)).min(1).max(16),
  })
  .strict();

export const ProjectMemoryReviewDraftSchema = z
  .object({
    fingerprint: hash,
    sources: z.array(ProjectMemoryReviewSourceSchema).max(64),
    items: z.array(ProjectMemoryReviewItemSchema).max(PROJECT_MEMORY_REVIEW_ITEM_LIMIT),
    partial: z.boolean(),
    summary: z.string().max(4000),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.items.reduce((sum, item) => sum + item.content.length, 0) >
      PROJECT_MEMORY_REVIEW_TOTAL_CHARACTERS
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Review content exceeds its total budget",
      });
    }
    const sources = new Set(value.sources.map((source) => source.id));
    const ids = new Set<string>();
    const paths = new Set<string>();
    for (const item of value.items) {
      if (
        ids.has(item.id) ||
        paths.has(item.fileName) ||
        item.sourceIds.some((id) => !sources.has(id))
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Review contains duplicate targets or unknown evidence",
        });
      }
      ids.add(item.id);
      paths.add(item.fileName);
    }
  });

export type ProjectMemoryReviewSource = z.infer<typeof ProjectMemoryReviewSourceSchema>;
export type ProjectMemoryReviewItem = z.infer<typeof ProjectMemoryReviewItemSchema>;
export type ProjectMemoryReviewDraft = z.infer<typeof ProjectMemoryReviewDraftSchema>;

export const ProjectMemoryVerificationSchema = z
  .object({
    acceptedItemIds: z.array(recordId).max(PROJECT_MEMORY_REVIEW_ITEM_LIMIT),
    reasons: z
      .array(z.object({ itemId: recordId, reason: z.string().max(2000) }).strict())
      .max(PROJECT_MEMORY_REVIEW_ITEM_LIMIT),
  })
  .strict();
export type ProjectMemoryVerification = z.infer<typeof ProjectMemoryVerificationSchema>;

export const ProjectMemoryReviewSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: recordId,
    createdAt: z.number().int().nonnegative(),
    revision: z.number().int().positive(),
    draft: ProjectMemoryReviewDraftSchema,
    verification: ProjectMemoryVerificationSchema.optional(),
    appliedItems: z.record(recordId, recordId),
  })
  .strict();
export type ProjectMemoryReview = z.infer<typeof ProjectMemoryReviewSchema>;

export const ProjectMemoryChangeSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: recordId,
    fileName: relativeMarkdownPath,
    createdAt: z.number().int().nonnegative(),
    beforeHash: hash.nullable(),
    afterHash: hash,
    status: z.enum(["prepared", "committed", "not-committed", "recovery-required"]),
    sessionId: z.string().optional(),
    undoOf: recordId.optional(),
    proposalId: recordId.optional(),
    proposalItemId: recordId.optional(),
  })
  .strict();
export type ProjectMemoryChange = z.infer<typeof ProjectMemoryChangeSchema>;

export interface ProjectMemoryOperationOptions {
  signal?: AbortSignal;
  trace?: TraceContext;
}

export interface ProjectMemoryPort {
  registerRoot(rootDir: string): Promise<void>;
  inspectCapacity(
    rootDir: string,
    options?: ProjectMemoryOperationOptions,
  ): Promise<{
    available: boolean;
    reason?: "history-full" | "reviews-full" | "preimages-full" | "recovery-required";
  }>;
  listChanges(
    rootDir: string,
    options?: ProjectMemoryOperationOptions,
  ): Promise<ProjectMemoryChange[]>;
  previewUndo(
    input: { rootDir: string; changeId: string },
    options?: ProjectMemoryOperationOptions,
  ): Promise<{ change: ProjectMemoryChange; content: string }>;
  undoChange(
    input: { rootDir: string; changeId: string; expectedHash: string; expectedBeforeHash: string },
    options?: ProjectMemoryOperationOptions,
  ): Promise<ProjectMemoryChange>;
  saveReview(
    input: {
      rootDir: string;
      draft: ProjectMemoryReviewDraft;
      verification?: ProjectMemoryVerification;
    },
    options?: ProjectMemoryOperationOptions,
  ): Promise<ProjectMemoryReview>;
  readReview(
    input: { rootDir: string; proposalId: string },
    options?: ProjectMemoryOperationOptions,
  ): Promise<ProjectMemoryReview>;
  listReviews(
    rootDir: string,
    options?: ProjectMemoryOperationOptions,
  ): Promise<ProjectMemoryReview[]>;
  applyReview(
    input: {
      rootDir: string;
      proposalId: string;
      revision: number;
      itemId: string;
      expectedItemHash: string;
      expectedSourceHashes: ReadonlyArray<{ fileName: string; hash: string }>;
    },
    options?: ProjectMemoryOperationOptions,
  ): Promise<ProjectMemoryChange>;
}
