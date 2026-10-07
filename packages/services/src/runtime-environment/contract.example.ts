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
