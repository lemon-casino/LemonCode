import { z } from "zod";
import { sessionExecutionModeSchema } from "./worktreePolicy.js";

/** 项目索引使用绑定来源；文件操作仍使用调用者的实际 workspace scope。 */
export function resolveWorktreeProjectScope(workspace: {
  workspacePath: string;
  workspaceIdentity?: string;
  executionBindingId?: string;
  originWorkspacePath?: string;
  originWorkspaceIdentity?: string;
}): { workspacePath: string; workspaceIdentity?: string } {
  // 工作树 checkout 不属于已添加的项目列表。只有绑定引用允许把索引投影回原项目。
  if (workspace.executionBindingId && workspace.originWorkspacePath) {
    return {
      workspacePath: workspace.originWorkspacePath,
      ...(workspace.originWorkspaceIdentity
        ? { workspaceIdentity: workspace.originWorkspaceIdentity }
        : {}),
    };
  }
  return {
    workspacePath: workspace.workspacePath,
    ...(workspace.workspaceIdentity ? { workspaceIdentity: workspace.workspaceIdentity } : {}),
  };
}

const text = z.string().trim().min(1);
export const executionIntentSchema = z
  .object({
    mode: sessionExecutionModeSchema,
    taskName: z.string().max(256).optional(),
    baseRef: text.optional(),
    originWorkspacePath: text.optional(),
    originWorkspaceIdentity: text.optional(),
    projectId: text.optional(),
    setupCommands: z.array(text).optional(),
    copyIgnoredPaths: z.array(text).optional(),
    retrySetup: z.boolean().optional(),
  })
  .strict();
export type ExecutionIntent = z.infer<typeof executionIntentSchema>;

export const worktreeSnapshotSchema = z
  .object({
    commit: text,
    indexTree: text,
    head: text,
    ignoredPaths: z.array(z.string()),
    createdAt: text,
  })
  .strict();
export type WorktreeSnapshot = z.infer<typeof worktreeSnapshotSchema>;
export const worktreePreparationSchema = z
  .object({
    stage: z.enum(["workspace", "checkout", "environment", "ready", "failed", "cancelled"]),
    activeStep: z.enum(["workspace", "checkout", "environment"]).optional(),
    log: z.string().max(65536),
    logTruncated: z.boolean(),
    cancelRequested: z.boolean(),
    environmentSource: z.enum(["explicit", "detected", "none"]),
  })
  .strict();
export const worktreeExecutionBindingSchema = z
  .object({
    id: text,
    taskId: text,
    requestId: text,
    projectId: text.optional(),
    workspacePath: text,
    workspaceIdentity: text.optional(),
    originalWorkspacePath: text,
    originalWorkspaceIdentity: text.optional(),
    repositoryRoot: text,
    commonDirectory: text,
    checkoutPath: text,
    branch: text,
    baseCommit: text,
    targetBranch: z.string(),
    sourceFolderPaths: z.array(text),
    status: z.enum([
      "preparing",
      "ready",
      "failed",
      "cancelled",
      "archived",
      "restoring",
      "missing",
      "deleting",
      "deleted",
    ]),
    preparation: worktreePreparationSchema.optional(),
    createdAt: text,
    updatedAt: text,
    error: z.string().optional(),
    latestIntegrationId: text.optional(),
    creationFingerprint: z
      .string()
      .regex(/^[a-f0-9]{32,64}$/)
      .optional(),
    snapshot: worktreeSnapshotSchema.optional(),
    deletion: z.object({ requestId: text, branchHead: text.optional() }).strict().optional(),
    forkSnapshot: worktreeSnapshotSchema.optional(),
    forkFilesRestored: z.boolean().optional(),
    setup: z
      .object({
        commands: z.array(text),
        copyIgnoredPaths: z.array(text),
        copied: z.boolean(),
        status: z.enum(["pending", "running", "completed", "failed"]),
        nextCommand: z.number().int().nonnegative(),
        results: z.array(
          z
            .object({ command: z.string(), exitCode: z.number().int(), output: z.string() })
            .strict(),
        ),
      })
      .strict()
      .optional(),
  })
  .strict();
export type WorktreeExecutionBinding = z.infer<typeof worktreeExecutionBindingSchema>;
const scope = { workspacePath: text, workspaceIdentity: text.optional() };
export const worktreePrepareExecutionParamsSchema = z
  .object({
    ...scope,
    requestId: text,
    taskId: text,
    projectId: text.optional(),
    baseRef: text.optional(),
    taskName: z.string().max(256).optional(),
    sourceFolderPaths: z.array(text).optional(),
    setupCommands: z.array(text).optional(),
    copyIgnoredPaths: z.array(text).optional(),
    retrySetup: z.boolean().optional(),
    cancel: z.boolean().optional(),
    forkSource: z
      .object({ workspacePath: text, workspaceIdentity: text.optional() })
      .strict()
      .optional(),
    parentBinding: z
      .object({ bindingId: text, bindingOwnerTaskId: text, parentTaskId: text })
      .strict()
      .optional(),
  })
  .strict();
export const worktreeGetBindingParamsSchema = z
  .object({ ...scope, taskId: text.optional(), requestId: text.optional() })
  .strict()
  .refine(
    (value) => Boolean(value.taskId || value.requestId),
    "Task or preparation request is required",
  );
export const worktreeGetBindingResultSchema = z
  .object({ binding: worktreeExecutionBindingSchema.nullable() })
  .strict();
export const worktreeRepairScopeSchema = z
  .object({ operationId: text, parentSessionId: text })
  .strict();
export const worktreePrepareRepairParamsSchema = z
  .object({ ...scope, requestId: text, parentSessionId: text, operationId: text })
  .strict();
export const worktreePrepareRepairResultSchema = z
  .object({
    operationId: text,
    parentSessionId: text,
    bindingId: text,
    workspacePath: text,
    sourceHead: text,
    targetHead: text,
    conflictPaths: z.array(text),
  })
  .strict();
export const worktreeCompleteRepairParamsSchema = worktreePrepareRepairParamsSchema;
export const worktreeCompleteRepairResultSchema = z
  .object({ operationId: text, status: text, candidateHead: text.optional() })
  .strict();
export type WorktreeRepairScope = z.infer<typeof worktreeRepairScopeSchema>;
export type WorktreeRepairContext = z.infer<typeof worktreePrepareRepairResultSchema>;
export const checkoutAcquireWriterParamsSchema = z
  .object({
    ...scope,
    requestId: text,
    sessionId: text,
    repair: worktreeRepairScopeSchema.optional(),
  })
  .strict();
export const checkoutAcquireWriterResultSchema = z.union([
  z.object({ permitId: text }).strict(),
  z.object({ busy: z.literal(true) }).strict(),
]);
export const checkoutReleaseWriterParamsSchema = z
  .object({ permitId: text, sessionId: text })
  .strict();
export const checkoutReleaseWriterResultSchema = z.object({ released: z.boolean() }).strict();
export type WorktreePrepareExecutionParams = z.infer<typeof worktreePrepareExecutionParamsSchema>;
export type WorktreeGetBindingParams = z.infer<typeof worktreeGetBindingParamsSchema>;
export type CheckoutAcquireWriterParams = z.infer<typeof checkoutAcquireWriterParamsSchema>;
export type CheckoutReleaseWriterParams = z.infer<typeof checkoutReleaseWriterParamsSchema>;
