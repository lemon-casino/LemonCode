import type { IWorktreeService } from "./contract.js";

export async function executeInSharedCheckout(
  service: IWorktreeService,
  workspacePath: string,
  sessionId: string,
  execute: () => Promise<void>,
) {
  const lease = await service.acquireCheckout({
    workspacePath,
    ownerId: sessionId,
    mode: "shared",
  });
  try {
    await execute();
  } finally {
    await service.releaseCheckout({ token: lease.token, ownerId: lease.ownerId });
  }
}

export async function createTaskWorktree(service: IWorktreeService, workspacePath: string) {
  return service.prepare({
    workspacePath,
    taskId: "task-example",
    requestId: "create-example",
    taskName: "修复模型切换",
  });
}

export async function readPreparation(
  service: IWorktreeService,
  workspacePath: string,
  requestId: string,
) {
  const binding = await service.getBinding({ workspacePath, requestId });
  if (binding?.status === "preparing")
    return service.prepare({ workspacePath, taskId: binding.taskId, requestId, cancel: true });
  return binding;
}

export async function inspectTaskMerge(
  service: IWorktreeService,
  bindingId: string,
  targetBranch: string,
) {
  // 只读预检查不是执行授权；提交或合并时仍由同一服务重验。
  return service.getIntegrationPreflight({ bindingId, targetBranch });
}

export async function discardTaskWorktree(
  service: IWorktreeService,
  binding: import("./contract.js").WorktreeBinding,
) {
  // 只发送一次确认；Host 在同一调用内继续原 journal 的临时文件锁重试，完成后才返回 deleted。
  return service.archive({
    bindingId: binding.id,
    requestId: "discard-confirmed-example",
    discard: { branch: binding.branch, checkoutPath: binding.checkoutPath },
  });
}

/** Host-only：重启后的 spawn 同样读取 Worktree owner 的持久删除状态，不暴露给 RPC。 */
export async function admitWorktreeAgent(
  host: import("./contract.js").IWorktreeHostService,
  scope: import("./contract.js").WorktreeScope,
) {
  await host.assertExecutionAdmission(scope);
}

/** Host 组合根注入停止 owner；生命周期调用者不自行操作 PID 或 consumer 存储。 */
export async function stopOwnedWorktreeExecution(
  ports: Pick<import("./contract.js").WorktreeRuntimePorts, "stopWorktreeExecution">,
  binding: import("./contract.js").WorktreeBinding,
) {
  await ports.stopWorktreeExecution?.(binding);
}

/** Host-only：已有 discard journal、真实 writer、精确历史清理后才迁移旧引用。 */
export async function retireLegacyDiscardConsumers(
  ports: Pick<import("./contract.js").WorktreeRuntimePorts, "retireLegacyRuntimeConsumers">,
  binding: import("./contract.js").WorktreeBinding,
  writer: import("./contract.js").CheckoutLease,
) {
  await ports.retireLegacyRuntimeConsumers?.({
    binding,
    writer,
    sessionIds: binding.deletion?.sessionIds ?? [],
  });
}
