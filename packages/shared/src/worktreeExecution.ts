import { z } from "zod";
import { sessionExecutionModeSchema, runtimeEnvironmentPolicySchema } from "./worktreePolicy.js";
import { runtimeEnvironmentErrorSchema } from "./runtimeEnvironment.js";
import {
  runtimeEnvironmentBindingReferenceSchema,
  runtimeEnvironmentReferenceSchema,
} from "./runtimeConsumer.js";

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
    /** additive；旧端缺省 = 不请求托管，不能把 inherit 解释成 managed。 */
    environmentPolicy: runtimeEnvironmentPolicySchema.optional(),
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

/** 候选环境与验证的精确收据；缺少该收据不能把 ready 解读为可发布。 */
export const worktreeValidationReceiptSchema = z
  .object({
    candidateHead: text,
    candidateTree: text,
    environmentRef: runtimeEnvironmentReferenceSchema.optional(),
    manifestDigest: text.optional(),
    declarationDigest: text.optional(),
    revision: z.number().int().positive().optional(),
    sourceHead: text.optional(),
    targetHead: text.optional(),
    targetBranch: text.optional(),
    environmentPolicy: z.enum(["managed", "local"]).optional(),
    command: z.string().max(8192).nullable(),
    outcome: z.enum(["passed", "failed", "skipped"]),
    exitCode: z.number().int().nullable(),
    output: z.string().max(65536),
    outputTruncated: z.boolean().optional(),
    skipAcknowledged: z.boolean().optional(),
    verifiedAt: text,
  })
  .strict()
  .superRefine((receipt, context) => {
    if (receipt.outcome === "skipped" && receipt.skipAcknowledged !== true) {
      context.addIssue({
        code: "custom",
        message: "skipped validation requires explicit acknowledgement",
      });
    }
    if (receipt.outcome === "passed" && receipt.exitCode !== 0) {
      context.addIssue({ code: "custom", message: "passed validation requires exitCode=0" });
    }
  });
export type WorktreeValidationReceipt = z.infer<typeof worktreeValidationReceiptSchema>;

/** 候选整体证据；目标/source 变更或环境收据不匹配时必须重新验证。 */
export const worktreeCandidateEvidenceSchema = z
  .object({
    candidateHead: text,
    candidateTree: text,
    sourceHead: text,
    targetHead: text,
    targetBranch: text.optional(),
    environmentPolicy: z.enum(["managed", "local"]).optional(),
    environmentRef: runtimeEnvironmentReferenceSchema.optional(),
    manifestDigest: text.optional(),
    declarationDigest: text.optional(),
    validationCommands: z.array(z.string().max(8192)).max(64).optional(),
    validationReceipts: z.array(worktreeValidationReceiptSchema).max(128),
    validatedAt: text,
  })
  .strict();
export type WorktreeCandidateEvidence = z.infer<typeof worktreeCandidateEvidenceSchema>;

export const worktreePreparationSchema = z
  .object({
    stage: z.enum(["workspace", "checkout", "environment", "ready", "failed", "cancelled"]),
    activeStep: z.enum(["workspace", "checkout", "environment"]).optional(),
    /** 托管环境的阶段投影（P2-07a）：environmentRef 存在时 UI 显示工具/依赖子阶段。 */
    runtimeStage: z.enum(["resolvingTools", "installingTools", "preparingDependencies"]).optional(),
    runtimeError: runtimeEnvironmentErrorSchema.optional(),
    log: z.string().max(65536),
    logTruncated: z.boolean(),
    cancelRequested: z.boolean(),
    environmentSource: z.enum(["explicit", "detected", "none"]),
    /** 工具来源标注（P2-07a）：项目声明/应用默认/用户覆盖/部分沿用本机。 */
    toolSource: z
      .enum(["project-declaration", "app-default", "user-override", "partial-host"])
      .optional(),
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
      "archiving",
      "archived",
      "restoring",
      "updating",
      "missing",
      "deleting",
      "deleted",
    ]),
    preparation: worktreePreparationSchema.optional(),
    createdAt: text,
    updatedAt: text,
    error: z.string().optional(),
    latestIntegrationId: text.optional(),
    /** 候选环境精确证据；旧 integration 记录缺失时继续可读，但不得被新发布路径视为 ready。 */
    candidateEvidence: worktreeCandidateEvidenceSchema.optional(),
    validationReceipts: z.array(worktreeValidationReceiptSchema).max(128).optional(),
    /** 恢复/删除与环境回收分别结算；不把代码快照当作私有数据备份。 */
    environmentRebuild: z
      .object({
        oldEnvironmentId: z
          .string()
          .regex(/^[a-f0-9]{32}$/)
          .optional(),
        oldEnvironmentRef: runtimeEnvironmentBindingReferenceSchema.optional(),
        newEnvironmentRef: runtimeEnvironmentReferenceSchema.optional(),
        sessionIds: z.array(text).optional(),
        status: z.enum(["pending", "ready", "failed", "requires-data-decision"]).optional(),
        dataDecision: z.enum(["save", "export", "discard"]).optional(),
      })
      .strict()
      .optional(),
    /** 托管运行环境引用（spec: specs/worktree-runtime-environments.md §7/§8.1）；首次执行前持久化。 */
    environmentRef: runtimeEnvironmentBindingReferenceSchema.optional(),
    environmentPolicy: z.enum(["managed", "local"]).optional(),
    archiveOperation: z.object({ requestId: text }).strict().optional(),
    restoration: z.object({ requestId: text }).strict().optional(),
    environmentUpgrade: z.object({ requestId: text }).strict().optional(),
    creationFingerprint: z
      .string()
      .regex(/^[a-f0-9]{32,64}$/)
      .optional(),
    snapshot: worktreeSnapshotSchema.optional(),
    deletion: z
      .object({
        requestId: text,
        branchHead: text.optional(),
        sessionIds: z.array(text).optional(),
      })
      .strict()
      .optional(),
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
    environmentPolicy: runtimeEnvironmentPolicySchema.optional(),
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
