import type {
  WorktreeManagementSettings,
  WorktreeCleanupResult,
  WorktreeExecutionBinding,
} from "@lcode/shared";

/** 同一 WorktreeService 的设置/目录合同，不创建第二个状态 owner。 */
export interface WorktreeManagement {
  getManagementSettings(): Promise<WorktreeManagementSettings>;
  updateManagementSettings(
    patch: Partial<WorktreeManagementSettings>,
  ): Promise<WorktreeManagementSettings>;
  rename(params: { bindingId: string; displayName: string }): Promise<WorktreeExecutionBinding>;
  cleanup(): Promise<WorktreeCleanupResult>;
}
