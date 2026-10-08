import type { WorktreeIntegration } from "@lcode/services";
import { createDiffSourceFilePreviewSource, type ReviewPreviewFile } from "@/lib/codeViewer.js";
import { isAbsoluteFilePath, joinFilePath } from "@/lib/path.js";

export const WORKTREE_REVIEW_STAGES = ["prepare", "review", "confirm", "complete"] as const;

export function worktreeReviewStage(operation: WorktreeIntegration | null): number {
  if (!operation || ["cancelled", "source-commit-failed", "failed"].includes(operation.status))
    return 0;
  if (["published", "up-to-date"].includes(operation.status)) return 3;
  if (operation.status === "ready" || operation.status === "publishing") return 2;
  return 1;
}

/** 沿 Git 的文件头切片，不拼接全部文件；真实路径由既有 diff 路径解析器处理。 */
export function integrationReviewFiles(
  patch: string,
  workspacePath: string,
  conflicts: readonly string[] = [],
): ReviewPreviewFile[] {
  const files = patch
    .split(/(?=^diff --git )/mu)
    .filter((part) => part.trim())
    .map((part, index) => ({
      path:
        createDiffSourceFilePreviewSource(
          { type: "patch", title: "diff", patch: part },
          workspacePath,
        )?.path ?? `diff ${index + 1}`,
      patch: part,
    }));
  const paths = new Map<string, ReviewPreviewFile>(files.map((file) => [file.path, file]));
  for (const path of conflicts) {
    const absolute = isAbsoluteFilePath(path) ? path : joinFilePath(workspacePath, path);
    if (!paths.has(absolute)) paths.set(absolute, { path: absolute });
  }
  return [...paths.values()];
}
