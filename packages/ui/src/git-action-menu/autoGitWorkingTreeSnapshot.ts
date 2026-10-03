import type { GitFileChange } from "@lcode/shared";
import type { IGitService } from "@lcode/services";

type GitSnapshotReader = Pick<IGitService, "refresh" | "getDiff">;

export interface GitWorkingTreeSnapshot {
  entries: ReadonlyMap<string, { path: string; fingerprint: string }>;
}

export async function captureGitWorkingTreeSnapshot(
  gitService: GitSnapshotReader,
  workspacePath: string,
  workspaceIdentity?: string,
): Promise<GitWorkingTreeSnapshot | null> {
  const refreshed = await gitService.refresh({
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
  });
  if (!refreshed.summary.isGitAvailable || !refreshed.summary.isRepository) return null;

  const files = [...refreshed.unstagedChanges, ...refreshed.stagedChanges];
  const entries = await Promise.all(
    files.map(async (file: GitFileChange) => {
      const key = JSON.stringify([file.section, file.repoRelativePath || file.path]);
      // 修复依据：工作流/子 Agent 的写入可能不进入主轮次摘要；单看增删行数又会漏掉等量改写。
      // 执行前后比较目标 Host 提供的 Git diff，不把任务开始前的脏文件误归给本次任务。
      const diff = await gitService.getDiff({
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        path: file.path,
        sourceId: file.isStaged ? "staged" : "unstaged",
      });
      return [
        key,
        {
          path: file.path,
          fingerprint: JSON.stringify([
            file.kind,
            file.added,
            file.removed,
            file.isUntracked,
            file.isConflicted,
            diff.availability,
            diff.patch,
            diff.afterContent,
          ]),
        },
      ] as const;
    }),
  );
  return { entries: new Map(entries) };
}

export function changedGitPathsSinceSnapshot(
  baseline: GitWorkingTreeSnapshot | null,
  final: GitWorkingTreeSnapshot | null,
): string[] {
  if (!baseline || !final) return [];
  return Array.from(
    new Set(
      [...final.entries].flatMap(([key, entry]) =>
        baseline.entries.get(key)?.fingerprint === entry.fingerprint ? [] : [entry.path],
      ),
    ),
  ).sort();
}
