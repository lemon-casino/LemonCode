import { z } from "zod";
import { worktreeExecutionBindingSchema } from "./worktreeExecution.js";
export const executionSetIntegrationSummarySchema = z.strictObject({
  operationId: z.string().min(1),
  bindingId: z.string().min(1),
  status: z.enum([
    "preparing",
    "committing-source",
    "source-commit-failed",
    "conflicted",
    "awaiting-review",
    "validating",
    "validation-failed",
    "ready",
    "publishing",
    "published",
    "up-to-date",
    "cancelled",
    "failed",
  ]),
  sourceHead: z.string().min(1),
  targetHead: z.string().min(1),
  targetBranch: z.string().min(1),
  candidateHead: z.string().optional(),
  updatedAt: z.string().min(1),
  error: z.string().optional(),
});
export const executionSetRepositoryViewsSchema = z
  .array(
    z.strictObject({
      repositoryId: z.string().regex(/^[a-f0-9]{32}$/),
      binding: worktreeExecutionBindingSchema.nullable(),
      integration: executionSetIntegrationSummarySchema.optional(),
      error: z.string().optional(),
    }),
  )
  .max(20);
export type ExecutionSetRepositoryView = z.infer<typeof executionSetRepositoryViewsSchema>[number];
