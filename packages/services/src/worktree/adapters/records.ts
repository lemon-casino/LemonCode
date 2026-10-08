import { z } from "zod";
import {
  worktreeExecutionBindingSchema,
  gitCommitRequestSchema,
  gitPublishStateSchema,
  runtimeEnvironmentBindingReferenceSchema,
  worktreeCandidateEvidenceSchema,
  worktreeValidationReceiptSchema,
} from "@lcode/shared";

const digest = z.string().regex(/^[a-f0-9]{40,64}$/);
const id = z.string().regex(/^[a-f0-9]{32}$/);
export const bindingRecord = worktreeExecutionBindingSchema;
export const operationRecord = z
  .object({
    id,
    requestId: z.string().min(1),
    bindingId: id,
    sourceHead: digest,
    initialSourceHead: digest.optional(),
    sourceCommits: z.array(gitCommitRequestSchema).optional(),
    sourceReceipts: z
      .array(
        z.object({
          reviewId: z.string(),
          groupId: z.string(),
          commitHash: digest,
          warning: z.string().optional(),
          publishState: gitPublishStateSchema.optional(),
        }),
      )
      .optional(),
    targetHead: digest,
    targetBranch: z.string().min(1),
    targetPath: z.string().min(1),
    repositoryPath: z.string().min(1).optional(),
    targetTemporary: z.boolean().optional(),
    checkoutPath: z.string().min(1),
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
      "cancelled",
      "failed",
    ]),
    candidateHead: digest.optional(),
    mergeBase: digest.optional(),
    conflictPaths: z.array(z.string()),
    diff: z.string().optional(),
    validationCommands: z.array(z.string()),
    validationSource: z.enum(["explicit", "detected", "none"]).optional(),
    validationResults: z.array(
      z.object({
        command: z.string(),
        exitCode: z.number(),
        output: z.string(),
        outputTruncated: z.boolean().optional(),
      }),
    ),
    environmentPolicy: z.enum(["managed", "local"]).optional(),
    environmentRef: runtimeEnvironmentBindingReferenceSchema.optional(),
    candidateEvidence: worktreeCandidateEvidenceSchema.optional(),
    validationReceipts: z.array(worktreeValidationReceiptSchema).max(128).optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
    error: z.string().optional(),
  })
  .strict();
