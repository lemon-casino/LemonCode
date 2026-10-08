import type { WorktreeIntegration } from "@lcode/services";

export function commitMergeState(
  operation: Pick<WorktreeIntegration, "id" | "status"> | undefined,
  view: { operationId: string; source: boolean } | null | undefined,
) {
  // 旧记录存在不代表正在合并；取消/失败/完成记录不能继续锁住下一次来源提交。
  const sourceLocked = Boolean(
    operation &&
    !["cancelled", "failed", "source-commit-failed", "published", "up-to-date"].includes(
      operation.status,
    ),
  );
  const chosen = operation && view?.operationId === operation.id;
  return { showMerge: Boolean(operation && (chosen ? !view!.source : sourceLocked)), sourceLocked };
}
