import type { AgentRuntimeInternal } from "./internal.js";

// 不保存第二份权限/队列，只记录事务已提交但事件尚未发布的恢复动作。
export const unpublishedPermissionGrants = new WeakMap<
  AgentRuntimeInternal,
  {
    interactionId: string;
    recover: () => Promise<string>;
  }
>();

export async function recoverPendingPermissionGrant(runtime: AgentRuntimeInternal): Promise<void> {
  await unpublishedPermissionGrants.get(runtime)?.recover();
}
