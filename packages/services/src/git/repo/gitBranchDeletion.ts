import { gitDeleteBranchRequestSchema } from "@lcode/shared";
import type { GitDeleteBranchRequest } from "@lcode/shared";
import type { GitCliRepo } from "./gitCliTypes.js";
import type { GitDeleteBranchResult } from "@lcode/shared";
import type { GitCommandProvider } from "../providers/gitCommandProvider.js";
import { DEFAULT_GIT_COMMAND_TIMEOUT_MS, DEFAULT_GIT_OUTPUT_BYTES } from "../config.js";

/** 只删除确认过且已合并的本地 ref；Git 仍最终裁定并发 worktree 占用。 */
export async function deleteLocalBranch(
  provider: GitCommandProvider,
  repoRoot: string,
  branchName: string,
  expectedCommitHash: string,
): Promise<GitDeleteBranchResult> {
  if (
    !branchName ||
    branchName.startsWith("-") ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(expectedCommitHash)
  )
    return { ok: false, code: "invalid" };
  const run = (args: string[]) =>
    provider.run({
      cwd: repoRoot,
      args,
      timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
      maxOutputBytes: DEFAULT_GIT_OUTPUT_BYTES,
    });
  const ref = `refs/heads/${branchName}`;
  const valid = await run(["check-ref-format", ref]);
  if (valid.exitCode !== 0) return { ok: false, code: "invalid" };
  const current = await run([
    "for-each-ref",
    "--format=%(objectname)%00%(worktreepath)",
    "--",
    ref,
  ]);
  if (current.exitCode !== 0) return { ok: false, code: "git-failed", detail: current.stderr };
  const [hash, checkedOutPath] = current.stdout.trimEnd().split("\0");
  // 用户确认后 refs 可能已变化；不能把列表缓存当作删除时的仓库事实。
  if (hash !== expectedCommitHash) return { ok: false, code: "changed" };
  if (checkedOutPath) return { ok: false, code: "in-use" };
  const merged = await run(["merge-base", "--is-ancestor", ref, "HEAD"]);
  if (merged.exitCode === 1) return { ok: false, code: "unmerged" };
  if (merged.exitCode !== 0) return { ok: false, code: "git-failed", detail: merged.stderr };
  const result = await run(["branch", "-d", "--", branchName]);
  if (result.exitCode !== 0) return { ok: false, code: "git-failed", detail: result.stderr };
  return { ok: true };
}

export function deleteBranchRequest(
  repo: GitCliRepo,
  rawParams: GitDeleteBranchRequest,
): Promise<GitDeleteBranchResult> {
  const params = gitDeleteBranchRequestSchema.parse(rawParams);
  return repo.deleteBranch(params.workspacePath, params.branchName, params.expectedCommitHash);
}
