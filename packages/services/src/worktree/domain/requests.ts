import { z } from "zod";
import { gitCommitRequestSchema, worktreePrepareExecutionParamsSchema } from "@lcode/shared";

const text = z.string().trim().min(1);
const id = z.string().regex(/^[a-f0-9]{32}$/);
const commit = z.string().regex(/^[a-f0-9]{40,64}$/);
const scope = { workspacePath: text, workspaceIdentity: text.optional() };
const commands = z.array(text.max(8192)).max(64);
export const worktreeRequests = {
  getCapabilities: z.object({ ...scope, sourceFolderPaths: z.array(text).optional() }).strict(),
  prepare: worktreePrepareExecutionParamsSchema,
  getBinding: z.object({ ...scope, taskId: text }).strict(),
  list: z.object(scope).strict(),
  integrate: z
    .object({
      requestId: text,
      bindingId: id,
      expectedSourceHead: commit,
      targetBranch: text,
      sourceCommits: z.array(gitCommitRequestSchema).min(1).max(100).optional(),
      validationCommands: commands.optional(),
    })
    .strict(),
  continueIntegration: z
    .object({
      operationId: id,
      cancel: z.boolean().optional(),
      approvedCandidateHead: commit.optional(),
      validationCommands: commands.optional(),
    })
    .strict()
    .refine(
      (params) => !params.cancel || (!params.approvedCandidateHead && !params.validationCommands),
      "Cancellation cannot also approve or validate a candidate",
    ),
  getIntegration: z.object({ operationId: id }).strict(),
  publishIntegration: z.object({ operationId: id, approvedCandidateHead: commit }).strict(),
  archive: z
    .object({ bindingId: id, requestId: text, acknowledgeIgnoredFiles: z.boolean().optional() })
    .strict(),
  restore: z.object({ bindingId: id, requestId: text }).strict(),
  acquireCheckout: z
    .object({ ...scope, ownerId: text, waitMs: z.number().int().min(1).max(30_000).optional() })
    .strict(),
  releaseCheckout: z.object({ token: text, ownerId: text }).strict(),
};
