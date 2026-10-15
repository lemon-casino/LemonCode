import type { IRuntimeEnvironmentService } from "./contract.js";

/** Main 只注入专用维护 port；UI 仍使用存储 clean 命令。 */
export function packageCacheMaintenance(
  cleaner: import("./contract.js").IRuntimePackageCacheCleaner,
  dataRootPath: string,
) {
  return cleaner.clean(dataRootPath);
}

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

/** 原 app 续用已交付授权；引用来自 Host acquire，不能从公开 RPC 输入构造。 */
export function continueAuthorizedApp(
  host: import("./contract.js").IRuntimeEnvironmentHostService,
  params: import("./contract.js").RuntimeEnvironmentResolveRequest,
  reference: import("@lcode/shared").RuntimeConsumerReference,
) {
  return host.resolveContext({ ...params, consumerReference: reference });
}

/** 仅原更新 journal 的 Worktree owner 在持有独占 writer 后调用；不是进程树退出证明。 */
export function recoverOrphanedUpgradeConsumer(
  authority: import("./contract.js").RuntimeEnvironmentConsumerAuthority,
  params: import("./contract.js").RuntimeConsumerUpgradeRecoveryParams,
) {
  if (!authority.retireOrphanedProcessesForUpgrade)
    throw new Error("Upgrade orphan recovery unavailable");
  return authority.retireOrphanedProcessesForUpgrade(params);
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
