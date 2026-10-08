import { worktreeIntegrationPreflightSchema, worktreeMergeResultSchema } from "@lcode/shared";
import type { WorktreeBinding, WorktreeIntegration } from "../contract.js";
import type { WorktreeContext } from "./ports.js";

export async function readIntegrationPreflight(
  context: WorktreeContext,
  binding: WorktreeBinding,
  targetBranch: string,
) {
  const { git } = context;
  const source = await git.inspect(binding.checkoutPath);
  if (source.commonDirectory !== binding.commonDirectory || source.branch !== binding.branch)
    throw new Error("Task source HEAD or worktree ownership changed");
  if (targetBranch === binding.branch) throw new Error("Integration source cannot target itself");
  const target = await git.resolveTarget(binding.repositoryRoot, targetBranch);
  const [commits, status] = await Promise.all([
    git.command(binding.repositoryRoot, ["rev-list", "--count", `${target.head}..${source.head}`]),
    git.command(binding.checkoutPath, ["status", "--porcelain=v1", "--untracked-files=all", "-z"]),
  ]);
  const entries = status.split("\0").filter(Boolean);
  let uncommittedFileCount = 0;
  for (let index = 0; index < entries.length; index++) {
    uncommittedFileCount++;
    // porcelain -z 的重命名/复制有第二个路径字段，不能把它计成另一个文件。
    if (/^[RC]|^.[RC]/u.test(entries[index]!)) index++;
  }
  const sourceCommitCount = Number(commits);
  return worktreeIntegrationPreflightSchema.parse({
    bindingId: binding.id,
    targetBranch,
    sourceHead: source.head,
    targetHead: target.head,
    sourceCommitCount,
    uncommittedFileCount,
    alreadyContained: sourceCommitCount === 0,
  });
}

export async function readMergeResult(context: WorktreeContext, operation: WorktreeIntegration) {
  const { git } = context;
  const [before, after, paths, commits] = await Promise.all([
    git.command(operation.checkoutPath, ["rev-parse", `${operation.targetHead}^{tree}`]),
    git.command(operation.checkoutPath, ["rev-parse", `${operation.candidateHead}^{tree}`]),
    git.command(operation.checkoutPath, [
      "diff",
      "--name-only",
      "-z",
      operation.targetHead,
      operation.candidateHead!,
      "--",
    ]),
    git.command(operation.checkoutPath, [
      "rev-list",
      "--count",
      `${operation.targetHead}..${operation.sourceHead}`,
    ]),
  ]);
  // 文本 diff 为空不证明无内容变化；树相同但有独有提交时仍须保留合并历史。
  return worktreeMergeResultSchema.parse({
    kind: before === after ? "history-only" : "content",
    changedFiles: paths.split("\0").filter(Boolean).length,
    sourceCommitCount: Number(commits),
    uncommittedFileCount: operation.mergeResult?.uncommittedFileCount ?? 0,
  });
}

export async function inspectIntegrationSource(
  context: WorktreeContext,
  binding: WorktreeBinding,
  operation: WorktreeIntegration,
): Promise<WorktreeIntegration> {
  const facts = await readIntegrationPreflight(context, binding, operation.targetBranch);
  if (facts.sourceHead !== operation.sourceHead)
    throw new Error("Task source HEAD or worktree ownership changed");
  if (facts.targetHead !== operation.targetHead)
    throw new Error("Target HEAD changed; create and review a new integration");
  if (
    !operation.sourceCommits?.length &&
    facts.uncommittedFileCount &&
    !operation.acknowledgeUncommitted
  )
    throw new Error("Uncommitted source changes must be explicitly excluded before integration");
  // 根因：Git 已包含来源时 merge 成功却没有新成果；在候选/环境准备之前持久化独立结论。
  return {
    ...operation,
    ...(facts.alreadyContained
      ? { status: "up-to-date", candidateHead: operation.targetHead, error: undefined }
      : {}),
    mergeResult: {
      kind: facts.alreadyContained ? "already-contained" : "content",
      changedFiles: 0,
      sourceCommitCount: facts.sourceCommitCount,
      uncommittedFileCount: facts.uncommittedFileCount,
    },
  };
}
