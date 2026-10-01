import { z } from "zod";

export const gitFileMutationSchema = z
  .object({
    id: z.string().min(1),
    sessionId: z.string().min(1),
    sessionTitle: z.string().optional(),
    path: z.string().min(1),
    beforeContent: z.string().nullable(),
    afterContent: z.string().nullable(),
    toolName: z.string(),
    createdAt: z.number().nonnegative(),
  })
  .strict();
export type GitFileMutation = z.infer<typeof gitFileMutationSchema>;
export const gitFileMutationJournalSchema = z
  .object({
    complete: z.boolean(),
    mutations: z.array(gitFileMutationSchema).max(500),
  })
  .strict();
export type GitFileMutationJournal = z.infer<typeof gitFileMutationJournalSchema>;

export const gitCommitReviewFileSchema = z
  .object({
    path: z.string().min(1),
    patch: z.string(),
    added: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
  })
  .strict();
export const gitCommitReviewGroupSchema = z
  .object({
    id: z.string().min(1),
    sessionIds: z.array(z.string()),
    label: z.string(),
    dependsOn: z.array(z.string()),
    message: z.string(),
    requiresConfirmation: z.boolean(),
    files: z.array(gitCommitReviewFileSchema),
  })
  .strict();
export const gitCommitReviewSchema = z
  .object({
    id: z.string().min(1),
    mode: z.enum(["split", "ordered", "merged"]),
    warnings: z.array(z.string()),
    groups: z.array(gitCommitReviewGroupSchema).min(1).max(20),
  })
  .strict();
export type GitCommitReview = z.infer<typeof gitCommitReviewSchema>;
export type GitCommitReviewGroup = z.infer<typeof gitCommitReviewGroupSchema>;
export const gitCommitReviewSelectionSchema = z
  .object({
    id: z.string().min(1),
    groupId: z.string().min(1),
    acknowledged: z.boolean(),
  })
  .strict();
export type GitCommitReviewSelection = z.infer<typeof gitCommitReviewSelectionSchema>;
