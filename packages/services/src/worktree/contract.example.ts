import type { IWorktreeService } from "./contract.js";

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
