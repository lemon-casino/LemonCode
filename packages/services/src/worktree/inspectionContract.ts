import type { WorktreeIntegrationPreflight } from "@lcode/shared";

/** 只读合并查询契约；与状态变更共用原 WorktreeService owner，不接受命令或人工授权。 */
export interface WorktreeIntegrationInspection {
  getIntegrationPreflight(params: {
    bindingId: string;
    targetBranch: string;
  }): Promise<WorktreeIntegrationPreflight>;
}
