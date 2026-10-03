import { resolve } from "node:path";
import {
  checkoutAcquireWriterParamsSchema,
  checkoutReleaseWriterParamsSchema,
  worktreeGetBindingParamsSchema,
  worktreePrepareExecutionParamsSchema,
  worktreeExecutionBindingSchema,
  worktreePrepareRepairParamsSchema,
  worktreeCompleteRepairParamsSchema,
} from "@lcode/shared";
import type { IWorktreeService, WorktreeScope } from "../worktree/contract.js";

export function isWorktreeRequest(method: string): boolean {
  return [
    "worktree/prepareExecution",
    "worktree/getBinding",
    "worktree/prepareRepair",
    "worktree/completeRepair",
    "checkout/acquireWriter",
    "checkout/releaseWriter",
  ].includes(method);
}

function sameScope(left: WorktreeScope, right: WorktreeScope): boolean {
  const leftIdentity = left.workspaceIdentity?.trim();
  const rightIdentity = right.workspaceIdentity?.trim();
  if ((leftIdentity || rightIdentity) && leftIdentity !== rightIdentity) return false;
  const normalized = (path: string) =>
    process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
  return normalized(left.workspacePath) === normalized(right.workspacePath);
}

export async function handleWorktreeRequest(
  method: string,
  params: unknown,
  workspace: WorktreeScope,
  service?: IWorktreeService,
): Promise<unknown> {
  if (!service) throw new Error("Worktree execution is not available on this Host.");
  const requireScope = (scope: WorktreeScope) => {
    // 中文依据：反向 RPC 只能访问当前 Agent 的所属 Environment，不按同名路径跨 Host 回退。
    if (!sameScope(scope, workspace))
      throw new Error("Worktree request scope does not match the Agent workspace.");
  };
  if (method === "worktree/prepareExecution") {
    const request = worktreePrepareExecutionParamsSchema.parse(params);
    requireScope(request);
    return worktreeExecutionBindingSchema.parse(await service.prepare(request));
  }
  if (method === "worktree/getBinding") {
    const request = worktreeGetBindingParamsSchema.parse(params);
    requireScope(request);
    const binding = await service.getBinding(request);
    return { binding: binding ? worktreeExecutionBindingSchema.parse(binding) : null };
  }
  const originKey = workspace.workspaceIdentity?.trim() || workspace.workspacePath;
  if (method === "worktree/prepareRepair" || method === "worktree/completeRepair") {
    const request = (
      method === "worktree/prepareRepair"
        ? worktreePrepareRepairParamsSchema
        : worktreeCompleteRepairParamsSchema
    ).parse(params);
    requireScope(request);
    const binding = await service.getBinding({ ...workspace, taskId: request.parentSessionId });
    const operation = await service.getIntegration({ operationId: request.operationId });
    if (!binding || !operation || operation.bindingId !== binding.id || binding.status !== "ready")
      throw new Error("Conflict repair does not belong to the parent session binding.");
    if (method === "worktree/completeRepair") {
      const result = await service.continueIntegration({ operationId: operation.id });
      return {
        operationId: result.id,
        status: result.status,
        ...(result.candidateHead ? { candidateHead: result.candidateHead } : {}),
      };
    }
    if (operation.status !== "conflicted")
      throw new Error("Integration is not waiting for conflict repair.");
    return {
      operationId: operation.id,
      parentSessionId: request.parentSessionId,
      bindingId: binding.id,
      workspacePath: operation.checkoutPath,
      sourceHead: operation.sourceHead,
      targetHead: operation.targetHead,
      conflictPaths: operation.conflictPaths,
    };
  }
  if (method === "checkout/acquireWriter") {
    const request = checkoutAcquireWriterParamsSchema.parse(params);
    if (request.repair) {
      const binding = await service.getBinding({
        ...workspace,
        taskId: request.repair.parentSessionId,
      });
      const operation = await service.getIntegration({ operationId: request.repair.operationId });
      if (
        !binding ||
        !operation ||
        operation.bindingId !== binding.id ||
        operation.status !== "conflicted" ||
        !sameScope(request, { workspacePath: operation.checkoutPath })
      )
        throw new Error("Conflict repair writer scope does not match the frozen operation.");
    } else if (!sameScope(request, workspace)) {
      const binding = await service.getBinding({ ...workspace, taskId: request.sessionId });
      if (!binding || binding.status !== "ready" || !sameScope(request, binding))
        throw new Error("Checkout writer scope does not match the task binding.");
    }
    try {
      const lease = await service.acquireCheckout({
        ...request,
        ownerId: `${originKey}:${request.sessionId}`,
        waitMs: 250,
      });
      return { permitId: lease.token };
    } catch (error) {
      // 忙碌只表示另一个真实 writer 仍在执行，不能使 CLI 已接受的输入失败或丢失。
      if ((error as { code?: unknown })?.code === "LCODE_CHECKOUT_BUSY") return { busy: true };
      throw error;
    }
  }
  if (method === "checkout/releaseWriter") {
    const request = checkoutReleaseWriterParamsSchema.parse(params);
    await service.releaseCheckout({
      token: request.permitId,
      ownerId: `${originKey}:${request.sessionId}`,
    });
    return { released: true };
  }
  throw new Error("Unknown worktree request.");
}
