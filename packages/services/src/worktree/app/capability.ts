import { relative, resolve, isAbsolute, sep } from "node:path";
import type { WorktreeCapabilities, WorktreeScope } from "../contract.js";
import type { WorktreeGit } from "./ports.js";

/**
 * 工作树能力探测（从 lifecycle.ts 抽出以守住 400 行上限）。
 * 只读 Git 事实，不改任何状态。
 */

export function mappedSourcePath(root: string, checkout: string, path: string): string {
  const child = relative(root, resolve(path));
  if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child))
    throw new Error("Source folders outside the Git repository cannot use a worktree");
  return resolve(checkout, child);
}

export async function worktreeCapability(
  git: WorktreeGit,
  params: WorktreeScope & { sourceFolderPaths?: string[] },
): Promise<WorktreeCapabilities> {
  try {
    const info = await git.inspect(params.workspacePath);
    for (const path of params.sourceFolderPaths ?? []) {
      mappedSourcePath(info.root, info.root, path);
      const source = await git.inspect(path);
      if (source.commonDirectory !== info.commonDirectory)
        throw new Error("Source folders must belong to one Git repository");
    }
    const superproject = await git.command(info.root, [
      "rev-parse",
      "--show-superproject-working-tree",
    ]);
    if (superproject) throw new Error("Submodule worktrees are not supported");
    return {
      supported: true,
      create: true,
      integrate: Boolean(info.branch),
      archive: true,
      restore: true,
      repositoryRoot: info.root,
      currentBranch: info.branch,
      head: info.head,
    };
  } catch (error) {
    return {
      supported: false,
      create: false,
      integrate: false,
      archive: false,
      restore: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
