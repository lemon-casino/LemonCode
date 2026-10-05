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

export async function discardTaskWorktree(
  service: IWorktreeService,
  binding: import("./contract.js").WorktreeBinding,
) {
  return service.archive({
    bindingId: binding.id,
    requestId: "discard-confirmed-example",
    discard: { branch: binding.branch, checkoutPath: binding.checkoutPath },
  });
}
