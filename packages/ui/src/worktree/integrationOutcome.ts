import type { WorktreeIntegration } from "@lcode/services";

export function integrationOutcome(operation: WorktreeIntegration) {
  if (operation.mergeResult) return operation.mergeResult.kind;
  // 历史 published 收据已校验祖先；候选等于目标基线可证明没有新合并，空文本 diff 本身不能证明。
  if (
    operation.status === "published" &&
    operation.candidateHead &&
    operation.candidateHead === operation.targetHead
  )
    return "already-contained";
  return "unknown";
}
