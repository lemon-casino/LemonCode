import { rename } from "node:fs/promises";
import type { GitCommandProvider } from "../providers/gitCommandProvider.js";
import { runCommitReviewHook } from "./commitReviewHooks.js";
import { ensureGitCommandSucceeded } from "./gitCliHelpers.js";

export async function publishCommitReviewRef(
  command: GitCommandProvider,
  cwd: string,
  index: string,
  ref: string,
  commitHash: string,
  oldHead: string | null,
) {
  try {
    const result = await command.run({
      cwd,
      args: ["update-ref", "-m", "lcode: reviewed commit", ref, commitHash, oldHead ?? ""],
      env: { GIT_INDEX_FILE: index, GIT_EDITOR: ":" },
      maxOutputBytes: 1_048_576,
    });
    ensureGitCommandSucceeded("git reviewed ref", result);
    return undefined;
  } catch (error) {
    // 中文依据：reference-transaction committed 通知可能在 ref 推进后超时；必须核对事实再决定是否失败。
    const current = await command.run({ cwd, args: ["rev-parse", "--verify", ref] });
    if (
      current.exitCode !== 0 ||
      current.timedOut ||
      current.outputTruncated ||
      current.stdout.trim() !== commitHash
    )
      throw error;
    const detail = error instanceof Error ? error.message : String(error);
    return `提交已经成功，但引用通知未完成，请刷新并重新审核剩余改动：${detail}`;
  }
}

export async function finishCommitReviewTransaction(
  command: GitCommandProvider,
  cwd: string,
  index: string,
  lockPath: string,
  indexPath: string,
  warning?: string,
) {
  const warnings = warning ? [warning] : [];
  try {
    await rename(lockPath, indexPath);
  } catch {
    warnings.push("提交已经成功，但暂存区更新失败；准备好的 index.lock 保留，请人工恢复后继续。");
  }
  try {
    await runCommitReviewHook(command, cwd, index, "post-commit");
  } catch (error) {
    // 中文依据：ref 已推进，通知 Hook 失败也必须返回成功事实，避免同组重试产生重复提交。
    const detail = error instanceof Error ? error.message : String(error);
    warnings.push(`提交已经成功，但 post-commit Hook 未完成：${detail}`);
  }
  return warnings.length ? warnings.join("\n") : undefined;
}
