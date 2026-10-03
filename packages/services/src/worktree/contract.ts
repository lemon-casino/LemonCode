import type { WorktreeExecutionBinding, GitCommitRequest, GitPublishState } from "@lcode/shared";
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
  projectId?: string;
  baseRef?: string;
  sourceFolderPaths?: string[];
  setupCommands?: string[];
  copyIgnoredPaths?: string[];
  retrySetup?: boolean;
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
  validationResults: { command: string; exitCode: number; output: string }[];
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
export interface IWorktreeService {
  getCapabilities(
    params: WorktreeScope & { sourceFolderPaths?: string[] },
  ): Promise<WorktreeCapabilities>;
  prepare(params: WorktreePrepareRequest): Promise<WorktreeBinding>;
  getBinding(params: WorktreeScope & { taskId: string }): Promise<WorktreeBinding | null>;
  list(params: WorktreeScope): Promise<WorktreeBinding[]>;
  integrate(params: WorktreeIntegrateRequest): Promise<WorktreeIntegration>;
  continueIntegration(params: {
    operationId: string;
    cancel?: boolean;
    approvedCandidateHead?: string;
    validationCommands?: string[];
  }): Promise<WorktreeIntegration>;
  getIntegration(params: { operationId: string }): Promise<WorktreeIntegration | null>;
  publishIntegration(params: {
    operationId: string;
    approvedCandidateHead: string;
  }): Promise<WorktreeIntegration>;
  archive(params: {
    bindingId: string;
    requestId: string;
    acknowledgeIgnoredFiles?: boolean;
  }): Promise<WorktreeBinding>;
  restore(params: { bindingId: string; requestId: string }): Promise<WorktreeBinding>;
  acquireCheckout(
    params: WorktreeScope & { ownerId: string; waitMs?: number },
  ): Promise<CheckoutLease>;
  releaseCheckout(params: { token: string; ownerId: string }): Promise<void>;
}
export const IWorktreeService = createServiceDescriptor<IWorktreeService>("worktree");
