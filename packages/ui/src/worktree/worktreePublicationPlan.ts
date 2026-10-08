import type { WorktreeIntegration } from "@lcode/services";
import type {
  GitPublishState,
  GitRemoteInfo,
  GitTagInfo,
  GitUnsupportedTagInfo,
} from "@lcode/shared";
import {
  freezePublishPlan,
  validatePublishOptions,
  type PublishOptions,
  type PublishPlan,
} from "@/git-action-menu/publishModel.js";

export function worktreePublicationPlan(input: {
  operation: Pick<WorktreeIntegration, "status" | "targetPath" | "targetBranch" | "repositoryPath">;
  workspaceIdentity?: string;
  state: GitPublishState;
  options: PublishOptions;
  remotes: GitRemoteInfo[];
  tags: GitTagInfo[];
  unsupportedTags?: GitUnsupportedTagInfo[];
}): { plan: PublishPlan; error?: never } | { error: string; plan?: never } {
  const { operation, state, options, tags } = input;
  // candidateHead 是历史合并收据；发布需冻结用户本次预览的目标分支最新 HEAD，不能用历史相等校验永久阻断后续发布。
  if (
    !["published", "up-to-date"].includes(operation.status) ||
    !state.headCommitHash ||
    state.branchName !== operation.targetBranch
  )
    return { error: "worktree.publishTargetChanged" };
  const invalid = validatePublishOptions(options, { ...input, withCommit: false });
  if (invalid) return { error: `git.publish.error.${invalid}` };
  return {
    plan: freezePublishPlan({
      request: {
        workspacePath: operation.repositoryPath ?? operation.targetPath,
        workspaceIdentity: input.workspaceIdentity,
        sourceBranch: operation.targetBranch,
      },
      options,
      state,
      tags,
      files: [],
    }),
  };
}
