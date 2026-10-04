import type {
  GitBranchMutationResult,
  GitDeleteBranchRequest,
  GitDeleteBranchResult,
  GitBranchComparison,
  GitCommitGraphRequest,
  GitCommitGraphResult,
  GitCreateBranchRequest,
  GitChangesRequest,
  GitCommitRequest,
  GitCommitResult,
  GitDiffQuery,
  GitDiffResult,
  GitDiscardPathsRequest,
  GitGenerateCommitMessageRequest,
  GitGenerateCommitMessageResult,
  GitIdentity,
  GitIgnoredPathsRequest,
  GitLocalBranchListResult,
  GitPathMutationRequest,
  GitPushRequest,
  GitPushResult,
  GitPublishState,
  GitPublicationRequest,
  GitRemoteListResult,
  GitTagListResult,
  GitCreateTagRequest,
  GitCreateTagResult,
  GitRefreshRequest,
  GitRefreshResult,
  GitRepositoryRequest,
  GitRepositorySummary,
  GitWorkspaceRepositoryInfo,
  GitFileChange,
  GitSwitchBranchRequest,
} from "@lcode/shared";
import { ServiceChannels } from "@lcode/shared";
import { createServiceDescriptor } from "../descriptors.js";
import type { Event } from "@lcode/rpc";
import type {
  GitReviewWorkspaceScope,
  GitReviewWorkspaceSnapshot,
  GitReviewWorkspaceUpdate,
  GitReviewWorkspaceUpdateResult,
  GitCommitReview,
} from "@lcode/shared";

export interface IGitService {
  getReviewWorkspace(params: GitReviewWorkspaceScope): Promise<GitReviewWorkspaceSnapshot>;
  updateReviewWorkspace(params: GitReviewWorkspaceUpdate): Promise<GitReviewWorkspaceUpdateResult>;
  onDynamicReviewWorkspace(params: GitReviewWorkspaceScope): Event<GitReviewWorkspaceSnapshot>;
  getCommitReview(
    params: GitRepositoryRequest & { reviewId: string },
  ): Promise<{ review: GitCommitReview; position: number } | null>;
  getRepositorySummary(params: GitRepositoryRequest): Promise<GitRepositorySummary>;
  getWorkspaceRepositoryInfo(params: GitRepositoryRequest): Promise<GitWorkspaceRepositoryInfo>;
  getLocalBranches(params: GitRepositoryRequest): Promise<GitLocalBranchListResult>;
  deleteBranch(params: GitDeleteBranchRequest): Promise<GitDeleteBranchResult>;
  getCommitGraph(params: GitCommitGraphRequest): Promise<GitCommitGraphResult>;
  switchBranch(params: GitSwitchBranchRequest): Promise<GitBranchMutationResult>;
  createBranchAndSwitch(params: GitCreateBranchRequest): Promise<GitBranchMutationResult>;
  getChanges(params: GitChangesRequest): Promise<GitFileChange[]>;
  getIgnoredPaths(params: GitIgnoredPathsRequest): Promise<string[]>;
  getDiff(params: GitDiffQuery): Promise<GitDiffResult>;
  getBranchComparison(params: GitRepositoryRequest): Promise<GitBranchComparison>;
  stagePaths(params: GitPathMutationRequest): Promise<void>;
  unstagePaths(params: GitPathMutationRequest): Promise<void>;
  discardPaths(params: GitDiscardPathsRequest): Promise<void>;
  generateCommitMessage(
    params: GitGenerateCommitMessageRequest,
  ): Promise<GitGenerateCommitMessageResult>;
  commit(params: GitCommitRequest): Promise<GitCommitResult>;
  push(params: GitPushRequest): Promise<GitPushResult>;
  getPublishState(params: GitPublicationRequest): Promise<GitPublishState>;
  listRemotes(params: GitRepositoryRequest): Promise<GitRemoteListResult>;
  listTags(params: GitRepositoryRequest): Promise<GitTagListResult>;
  createTag(params: GitCreateTagRequest): Promise<GitCreateTagResult>;
  getIdentity(params: GitRepositoryRequest): Promise<GitIdentity>;
  refresh(params: GitRefreshRequest): Promise<GitRefreshResult>;
}

export const IGitService = createServiceDescriptor<IGitService>(ServiceChannels.Git);
