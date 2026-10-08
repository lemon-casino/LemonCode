import type {
  WorktreeExecutionBinding,
  GitCommitRequest,
  GitPublishState,
  RuntimeEnvironmentPolicy,
  RuntimeEnvironmentBindingReference,
  RuntimeEnvironmentReference,
  WorktreeCandidateEvidence,
  WorktreeValidationReceipt,
} from "@lcode/shared";
export type { WorktreeSnapshot } from "@lcode/shared";
export type WorktreeBinding = WorktreeExecutionBinding;

import { createServiceDescriptor } from "../descriptors.js";

export interface WorktreeScope {
  workspacePath: string;
  workspaceIdentity?: string;
}
export interface WorktreeCapabilities {
  supported: boolean;
  create: boolean;
  integrate: boolean;
  archive: boolean;
  restore: boolean;
  reason?: string;
  repositoryRoot?: string;
  currentBranch?: string;
  head?: string;
}
export interface WorktreePrepareRequest extends WorktreeScope {
  requestId: string;
  taskId: string;
  taskName?: string;
  environmentPolicy?: RuntimeEnvironmentPolicy;
  projectId?: string;
  baseRef?: string;
  sourceFolderPaths?: string[];
  setupCommands?: string[];
  copyIgnoredPaths?: string[];
  retrySetup?: boolean;
  cancel?: boolean;
  forkSource?: WorktreeScope;
  parentBinding?: { bindingId: string; bindingOwnerTaskId: string; parentTaskId: string };
}
export interface WorktreeIntegration {
  id: string;
  requestId: string;
  bindingId: string;
  sourceHead: string;
  initialSourceHead?: string;
  sourceCommits?: GitCommitRequest[];
  sourceReceipts?: {
    reviewId: string;
    groupId: string;
    commitHash: string;
    warning?: string;
    publishState?: GitPublishState;
  }[];
  targetHead: string;
  targetBranch: string;
  targetPath: string;
  /** 原仓库访问路径；发布读取目标 ref，不依赖临时目标目录。 */
  repositoryPath?: string;
  targetTemporary?: boolean;
  checkoutPath: string;
  status:
    | "preparing"
    | "committing-source"
    | "source-commit-failed"
    | "conflicted"
    | "awaiting-review"
    | "validating"
    | "validation-failed"
    | "ready"
    | "publishing"
    | "published"
    | "cancelled"
    | "failed";
  candidateHead?: string;
  mergeBase?: string;
  conflictPaths: string[];
  diff?: string;
  validationCommands: string[];
  validationSource?: "explicit" | "detected" | "none";
  validationResults: {
    command: string;
    exitCode: number;
    output: string;
    outputTruncated?: boolean;
  }[];
  environmentPolicy?: "managed" | "local";
  /** 失败分配可保留 revision=0 供清理；执行与验证证据仍要求正 revision。 */
  environmentRef?: RuntimeEnvironmentBindingReference;
  candidateEvidence?: WorktreeCandidateEvidence;
  validationReceipts?: WorktreeValidationReceipt[];
  createdAt: string;
  updatedAt: string;
  error?: string;
}
export interface WorktreeIntegrateRequest {
  requestId: string;
  bindingId: string;
  expectedSourceHead: string;
  sourceCommits?: GitCommitRequest[];
  targetBranch: string;
  validationCommands?: string[];
}
export interface CheckoutLease {
  token: string;
  workspacePath: string;
  ownerId: string;
}
export interface PreparedWorktreeRuntime {
  environmentId: string;
  revision: number;
  manifestDigest: string;
  declarationDigest?: string;
  env?: Record<string, string>;
  dependenciesPrepared?: boolean;
  toolSource?: "project-declaration" | "app-default" | "user-override" | "partial-host";
}
/** 仅由可信组合根注入；writer/env 不进入 RPC 或持久公开投影。 */
export interface WorktreeRuntimePorts {
  prepareRuntimeEnvironment?: (
    params: {
      bindingId: string;
      checkoutPath: string;
      requestId: string;
      purpose: "worktree" | "integration-candidate";
      operation?: "prepare" | "upgrade" | "restore";
      cancel?: boolean;
      environmentId?: string;
      expectedRevision?: number;
      expectedManifestDigest?: string;
    },
    writer?: CheckoutLease,
  ) => Promise<PreparedWorktreeRuntime>;
  resolveRuntimeEnvironment?: (params: {
    bindingId: string;
    checkoutPath: string;
    environmentRef: RuntimeEnvironmentBindingReference;
  }) => Promise<PreparedWorktreeRuntime>;
  releaseRuntimeEnvironment?: (params: {
    binding?: WorktreeBinding;
    bindingId: string;
    checkoutPath: string;
    requestId: string;
    environmentRef: RuntimeEnvironmentBindingReference;
    intent: "discard" | "archive" | "candidate-cancel" | "upgrade";
    phase: "fence" | "stop" | "cleanup" | "finalize";
  }) => Promise<{ status: "completed" | "releaseBlocked"; reason?: string }>;
  rebindRuntimeEnvironmentSessions?: (params: {
    binding: WorktreeBinding;
    requestId: string;
    oldEnvironmentRef: RuntimeEnvironmentBindingReference;
    newEnvironmentRef: RuntimeEnvironmentReference;
  }) => Promise<{ sessionIds: string[] }>;
}
export type WorktreeCommandRunner = (
  checkoutPath: string,
  command: string,
  onOutput?: (output: string) => Promise<void>,
  env?: Record<string, string>,
) => Promise<{ exitCode: number; output: string; outputTruncated?: boolean }>;

/** 普通会话共享执行；会修改目录生命周期/快照/发布的操作保持独占。 */
export type CheckoutAccessMode = "shared" | "exclusive";
export interface IWorktreeService {
  getCapabilities(
    params: WorktreeScope & { sourceFolderPaths?: string[] },
  ): Promise<WorktreeCapabilities>;
  prepare(params: WorktreePrepareRequest): Promise<WorktreeBinding>;
  getBinding(
    params: WorktreeScope & { taskId?: string; requestId?: string },
  ): Promise<WorktreeBinding | null>;
  list(params: WorktreeScope): Promise<WorktreeBinding[]>;
  integrate(params: WorktreeIntegrateRequest): Promise<WorktreeIntegration>;
  continueIntegration(params: {
    operationId: string;
    cancel?: boolean;
    approvedCandidateHead?: string;
    validationCommands?: string[];
    skipValidation?: boolean;
  }): Promise<WorktreeIntegration>;
  getIntegration(params: { operationId: string }): Promise<WorktreeIntegration | null>;
  publishIntegration(params: {
    operationId: string;
    approvedCandidateHead: string;
    skipValidation?: boolean;
  }): Promise<WorktreeIntegration>;
  archive(params: {
    bindingId: string;
    requestId: string;
    acknowledgeIgnoredFiles?: boolean;
    /** 显式确认后永久删除目录、任务分支、绑定快照 refs 及同树聊天；普通 archive 保留聊天。 */
    discard?: { branch: string; checkoutPath: string };
  }): Promise<WorktreeBinding>;
  restore(params: { bindingId: string; requestId: string }): Promise<WorktreeBinding>;
  acquireCheckout(
    params: WorktreeScope & { ownerId: string; waitMs?: number; mode?: CheckoutAccessMode },
  ): Promise<CheckoutLease>;
  releaseCheckout(params: { token: string; ownerId: string }): Promise<void>;
}
export type IWorktreeHostService = IWorktreeService &
  import("./hostContract.js").WorktreeHostActions;
export const IWorktreeService = createServiceDescriptor<IWorktreeService>("worktree");
