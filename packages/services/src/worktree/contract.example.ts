import type { IWorktreeService } from "./contract.js";

export async function createTaskWorktree(service: IWorktreeService, workspacePath: string) {
  return service.prepare({ workspacePath, taskId: "task-example", requestId: "create-example" });
}
