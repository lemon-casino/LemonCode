import type { RuntimeEnvironmentBindingReference, WorktreeExecutionBinding } from "@lcode/shared";

/** 可信 Host 组合根使用；公开 RPC 必须经 createPublicWorktreeService 白名单。 */
export interface WorktreeHostActions {
  upgradeRuntimeEnvironment(params: {
    bindingId: string;
    requestId: string;
    expectedEnvironmentRef: RuntimeEnvironmentBindingReference;
    cancel?: boolean;
  }): Promise<WorktreeExecutionBinding>;
}
