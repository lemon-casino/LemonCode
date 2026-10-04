import type { WorktreeIntegration } from "../contract.js";
import type { WorktreeContext } from "./ports.js";

export async function cleanupTemporaryTarget(
  context: WorktreeContext,
  operation: WorktreeIntegration,
) {
  if (!operation.targetTemporary) return;
  const { store, git } = context;
  await store.assertManagedPath(operation.targetPath);
  if (
    operation.targetPath !== store.checkout(store.key(`integration-target:${operation.id}`)) ||
    !operation.repositoryPath
  )
    throw new Error("Temporary target ownership does not match its record");
  if (!(await store.exists(operation.targetPath))) return;
  const actual = await git.inspect(operation.targetPath);
  const expected =
    operation.status === "published" ? operation.candidateHead : operation.targetHead;
  if (
    actual.head !== expected ||
    (actual.branch && actual.branch !== operation.targetBranch) ||
    (await git.command(operation.targetPath, ["status", "--porcelain", "--untracked-files=all"]))
  )
    throw new Error("Temporary target changed; preserve its files");
  // 临时目录有独立所有权；只让原生 Git 删除干净目录，不扩大到用户的其他工作树。
  await git.command(operation.repositoryPath, ["worktree", "remove", operation.targetPath]);
}
