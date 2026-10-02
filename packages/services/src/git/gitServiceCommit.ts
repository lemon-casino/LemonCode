import type { GitCommitRequest, GitCommitResult } from "@lcode/shared";
import type { CommitReviewService } from "./commitReviewService.js";
import type { GitCliRepo } from "./repo/gitCliTypes.js";
import type { GitPublishStateReader } from "./repo/gitPublishState.js";

export async function commitWithPublishState(
  repo: GitCliRepo,
  reviews: CommitReviewService | null,
  state: GitPublishStateReader,
  params: GitCommitRequest,
): Promise<GitCommitResult> {
  const expected = params.expectedState;
  let committed: GitCommitResult;
  if (params.review) {
    if (!reviews) throw new Error("提交审核不可用。");
    committed = {
      ...(await reviews.commit(
        params,
        expected ? () => state.assertCurrent(params.workspacePath, expected) : undefined,
      )),
    };
  } else {
    const summary = (await repo.getStatus(params.workspacePath)).summary;
    if (params.expectedState) await state.assertCurrent(params.workspacePath, params.expectedState);
    committed = {
      ...(await repo.commit(params.workspacePath, params.message, params.paths, {
        stagedOnly: params.stagedOnly,
      })),
      summary,
    };
  }
  // 中文依据：commitHash 是已完成事实，后续状态刷新/Hook/并发检测失败只能附警告，不能谎报未提交诱发重复提交。
  try {
    repo.invalidate(params.workspacePath);
    committed = { ...committed, summary: (await repo.getStatus(params.workspacePath)).summary };
  } catch {
    committed.warning ??= "提交已成功，但状态刷新失败，请刷新后查看。";
  }
  if (params.expectedState) {
    try {
      const next = await state.capture(params.workspacePath);
      if (
        next.headCommitHash !== committed.commitHash ||
        next.branchName !== params.expectedState.branchName ||
        next.worktreeFingerprint !== params.expectedState.worktreeFingerprint
      ) {
        throw new Error("HEAD、分支或工作树在提交后发生变化，请重新确认发布。");
      }
      if (!committed.warning) committed.publishState = next;
    } catch (error) {
      committed.warning = [
        committed.warning,
        `提交已成功，但${error instanceof Error ? error.message : String(error)}`,
      ]
        .filter(Boolean)
        .join("\n");
      delete committed.publishState;
    }
  }
  return committed;
}
