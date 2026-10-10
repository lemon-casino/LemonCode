import type { IRuntimeEnvironmentService } from "./contract.js";

/** 契约用法示例（架构治理 contract.example 惯例）；不是运行时代码。 */
export async function prepareWorktreeEnvironment(
  service: IRuntimeEnvironmentService,
  workspacePath: string,
) {
  const capabilities = await service.getCapabilities({ workspacePath });
  if (!capabilities.managedEnvironments) return null;
  const operation = await service.prepare({
    workspacePath,
    requestId: "example-request-id",
    purpose: "worktree",
  });
  if (operation.status !== "succeeded") return operation;
  return service.snapshot({ workspacePath, environmentId: operation.environmentId });
}

/** Host-only：processOwner 由实际 client 读取，调用前必须已有进程树退出证明。 */
export async function settleExitedRuntimeConsumer(
  authority: import("./contract.js").RuntimeEnvironmentConsumerAuthority,
  reference: import("@lcode/shared").RuntimeConsumerReleaseParams,
  processOwner: import("./contract.js").RuntimeConsumerProcessOwner,
) {
  if (!authority.confirmProcessExit) throw new Error("Process owner receipts unavailable");
  await authority.confirmProcessExit(reference, processOwner);
  return authority.release(reference);
}

/** Host-only：观察不存在仅允许删除事务继续取得 writer，不能调用 confirmProcessExit。 */
export async function inspectDiscardOwner(
  observe: import("./contract.js").RuntimeProcessOwnerObserver,
  owner: import("./contract.js").RuntimeConsumerProcessOwner,
) {
  return (await observe(owner)) === "absent";
}

/** Host-only：physical fs 由组合根注入，资源 owner 完成目标根校验后调用。 */
export function resourceRemovalPort(
  remove: import("./contract.js").RuntimeResourceDirectoryRemover,
) {
  return { removeResourceDirectory: remove };
}
