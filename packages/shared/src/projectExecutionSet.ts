import { z } from "zod";
import { projectContextSnapshotSchema } from "./projectContext.js";
const text = z.string().trim().min(1).max(32768);
const id = z.string().regex(/^[a-f0-9]{32}$/);
export const executionSetScopeSchema = z.strictObject({
  workspacePath: text,
  workspaceIdentity: text.optional(),
});
export const executionSetRefSchema = z.strictObject({
  executionSetId: id,
  projectId: text,
  origin: executionSetScopeSchema,
  bindings: z
    .array(
      z.strictObject({
        repositoryId: id,
        bindingId: id,
        workspacePath: text,
        workspaceIdentity: text.optional(),
      }),
    )
    .min(1)
    .max(20),
});
export type ExecutionSetRef = z.infer<typeof executionSetRefSchema>;
export const executionSetRepositorySchema = z.strictObject({
  id,
  repositoryRoot: text,
  commonDirectory: text,
  baseRef: text,
  memberIds: z.array(text).min(1).max(20),
  status: z.enum(["planned", "preparing", "ready", "failed", "archived"]),
  bindingId: id.optional(),
  error: z.string().max(65536).optional(),
});
export const executionSetSnapshotSchema = z.strictObject({
  version: z.literal(1),
  id,
  name: z.string().trim().min(1).max(120),
  revision: z.number().int().nonnegative(),
  requestId: text,
  fingerprint: text,
  preparationName: z.string().trim().min(1).max(120),
  origin: executionSetScopeSchema,
  projectContext: projectContextSnapshotSchema,
  status: z.enum([
    "preflighting",
    "preparing",
    "ready",
    "failed",
    "archiving",
    "archived",
    "restoring",
  ]),
  repositories: z.array(executionSetRepositorySchema).max(20),
  error: z.string().max(65536).optional(),
  sessions: z
    .array(
      z.strictObject({
        sessionId: text,
        operationId: text,
        status: z.enum(["attaching", "attached", "released"]),
      }),
    )
    .max(10000),
  archiveOperationId: text.optional(),
  archiveIgnoredAcknowledged: z.boolean().optional(),
  archiveSessionIds: z.array(text).max(10000).optional(),
  archiveStopReceipt: z.strictObject({ operationId: text, sessionIds: z.array(text) }).optional(),
  restoreOperationId: text.optional(),
  baseRefs: z.record(z.string(), text).optional(),
  preflightFailure: z.strictObject({ memberId: text, sourcePath: text, error: text }).optional(),
  forkSource: executionSetRefSchema.optional(),
  metadataOperation: z.strictObject({ operationId: text, name: text }).optional(),
  createdAt: text,
  updatedAt: text,
});
export type ExecutionSetSnapshot = z.infer<typeof executionSetSnapshotSchema>;
export const executionSetPrepareRequestSchema = z.strictObject({
  operationId: text,
  name: z.string().trim().min(1).max(120),
  projectContext: projectContextSnapshotSchema,
  baseRefs: z.record(z.string(), text).optional(),
  forkSource: executionSetRefSchema.optional(),
});
export type ExecutionSetPrepareRequest = z.infer<typeof executionSetPrepareRequestSchema>;
export const executionSetPrepareExecutionParamsSchema = executionSetScopeSchema.extend({
  requestId: text,
  sessionId: text,
  name: text.max(120),
  projectContext: projectContextSnapshotSchema.optional(),
  executionSetId: id.optional(),
  baseRefs: z.record(z.string(), text).optional(),
  forkSource: z.strictObject({ executionSetId: id, sessionId: text }).optional(),
});
export const executionSetResolveExecutionParamsSchema = executionSetScopeSchema.extend({
  executionSetId: id,
  sessionId: text,
});
export const executionSetExecutionResultSchema = z.strictObject({
  reference: executionSetRefSchema,
  context: projectContextSnapshotSchema,
});
