import type { GitRefreshRequest } from "@lcode/shared";
import type { GitBranchComparisonSnapshot, GitCliRepo } from "./repo/gitCliRepo.js";

export async function readOptionalBranchComparison(
  repo: GitCliRepo,
  params: GitRefreshRequest,
): Promise<{ snapshot: GitBranchComparisonSnapshot | null; error?: string }> {
  if (!params.includeBranchComparison) return { snapshot: null };
  // status 会保留配置的 upstream 名称，即使跟踪引用已不存在。可选比较失败
  // 不能让有效的已暂存/未暂存快照一起丢失；诊断随 branch 来源单独返回。
  try {
    return { snapshot: await repo.getBranchComparison(params.workspacePath) };
  } catch (error) {
    return {
      snapshot: null,
      error: error instanceof Error ? error.message || error.name : String(error),
    };
  }
}
