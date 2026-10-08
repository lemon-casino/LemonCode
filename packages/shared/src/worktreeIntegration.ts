import { z } from "zod";

const id = z.string().regex(/^[a-f0-9]{32}$/);
const commit = z.string().regex(/^[a-f0-9]{40,64}$/);
const count = z.number().int().nonnegative();
export const worktreeIntegrationPreflightRequestSchema = z
  .object({
    bindingId: id,
    targetBranch: z.string().trim().min(1),
  })
  .strict();
export const worktreeIntegrationPreflightSchema = worktreeIntegrationPreflightRequestSchema
  .extend({
    sourceHead: commit,
    targetHead: commit,
    sourceCommitCount: count,
    uncommittedFileCount: count,
    alreadyContained: z.boolean(),
  })
  .strict();
export const worktreeMergeResultSchema = z
  .object({
    kind: z.enum(["already-contained", "history-only", "content"]),
    changedFiles: count,
    sourceCommitCount: count,
    uncommittedFileCount: count,
  })
  .strict();
export type WorktreeIntegrationPreflight = z.infer<typeof worktreeIntegrationPreflightSchema>;
export type WorktreeMergeResult = z.infer<typeof worktreeMergeResultSchema>;
