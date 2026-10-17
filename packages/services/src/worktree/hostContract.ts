import type { RuntimeEnvironmentBindingReference, WorktreeExecutionBinding } from "@lcode/shared";
import type { WorktreeOwnedBindings } from "./ownedBindingContract.js";

/** 可信 Host 组合根使用；公开 RPC 必须经 createPublicWorktreeService 白名单。 */
export interface WorktreeHostActions extends WorktreeOwnedBindings {
  assertExecutionAdmission(scope: import("./contract.js").WorktreeScope): Promise<void>;
  /** 仅校验本 Host 的物理监听句柄，不改变执行身份隔离或提供 RPC 入口。 */
  assertFileWatchAdmission(path: string): Promise<void>;
  upgradeRuntimeEnvironment(params: {
    bindingId: string;
    requestId: string;
    expectedEnvironmentRef: RuntimeEnvironmentBindingReference;
    cancel?: boolean;
  }): Promise<WorktreeExecutionBinding>;
}
