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
import type { ProjectExecutionSetHostService } from "../project-execution-set/contract.js";
import {
  executionSetPrepareExecutionParamsSchema,
  executionSetResolveExecutionParamsSchema,
  resolveWorkspaceKey,
} from "@lcode/shared";

export function isWorktreeRequest(method: string): boolean {
  return [
    "worktree/prepareExecution",
    "worktree/getBinding",
    "worktree/prepareRepair",
    "worktree/completeRepair",
    "checkout/acquireWriter",
    "checkout/releaseWriter",
    "executionSet/prepareExecution",
    "executionSet/resolveExecution",
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
  executionSets?: ProjectExecutionSetHostService,
): Promise<unknown> {
  if (!service) throw new Error("Worktree execution is not available on this Host.");
  // 原因：client 可由 commands/query 启动，workspace 实参还带 commands/clock/可信载体。
  // 路由字段不能展开进严格服务请求；只投影 scope，原 identity 校验继续保留。
  const originScope: WorktreeScope = {
    workspacePath: workspace.workspacePath,
    ...(workspace.workspaceIdentity ? { workspaceIdentity: workspace.workspaceIdentity } : {}),
  };
  const requireScope = (scope: WorktreeScope) => {
    // 中文依据：反向 RPC 只能访问当前 Agent 的所属 Environment，不按同名路径跨 Host 回退。
    if (!sameScope(scope, workspace))
      throw new Error("Worktree request scope does not match the Agent workspace.");
  };
  if (method === "executionSet/prepareExecution") {
    if (!executionSets)
      throw new Error("Collaboration execution sets are unavailable on this Host");
    const request = executionSetPrepareExecutionParamsSchema.parse(params);
    requireScope(request);
    let snapshot = request.executionSetId
      ? await executionSets.get({ ...originScope, executionSetId: request.executionSetId })
      : await executionSets.getPreparation({ ...originScope, operationId: request.requestId });
    if (request.executionSetId && request.forkSource)
      throw new Error("Choose either an existing set or an independent fork");
    if (!snapshot) {
      if (request.executionSetId) throw new Error("Execution set no longer exists");
      if (request.forkSource) {
        const source = await executionSets.get({
          ...originScope,
          executionSetId: request.forkSource.executionSetId,
        });
        if (!source) throw new Error("Fork source execution set not found");
        const resolved = await executionSets.resolveContext({
          ...originScope,
          executionSetId: source.id,
          sessionId: request.forkSource.sessionId,
        });
        snapshot = await executionSets.prepare({
          operationId: request.requestId,
          name: request.name,
          projectContext: source.projectContext,
          forkSource: resolved.reference,
        });
      } else {
        if (
          !request.projectContext ||
          resolveWorkspaceKey(request.projectContext.origin) !== resolveWorkspaceKey(originScope)
        )
          throw new Error("Project context does not match the attached source");
        snapshot = await executionSets.prepare({
          operationId: request.requestId,
          name: request.name,
          projectContext: request.projectContext,
          baseRefs: request.baseRefs,
        });
      }
    } else if (!request.executionSetId) {
      if (
        snapshot.preparationName !== request.name ||
        JSON.stringify(snapshot.baseRefs) !== JSON.stringify(request.baseRefs)
      )
        throw new Error("Execution set preparation differs from its original request");
      if (
        (snapshot.forkSource?.executionSetId ?? null) !==
        (request.forkSource?.executionSetId ?? null)
      )
        throw new Error("Execution set fork source differs from its original request");
      if (snapshot.status !== "ready")
        snapshot = await executionSets.retry({
          ...originScope,
          executionSetId: snapshot.id,
          operationId: snapshot.requestId,
        });
    }
    if (snapshot.status !== "ready")
      throw new Error(snapshot.error ?? "Collaboration repositories are not all ready");
    await executionSets.attachSession({
      ...originScope,
      executionSetId: snapshot.id,
      sessionId: request.sessionId,
      operationId: request.requestId,
    });
    return executionSets.resolveContext({
      ...originScope,
      executionSetId: snapshot.id,
      sessionId: request.sessionId,
    });
  }
  if (method === "executionSet/resolveExecution") {
    if (!executionSets)
      throw new Error("Collaboration execution sets are unavailable on this Host");
    const request = executionSetResolveExecutionParamsSchema.parse(params);
    requireScope(request);
    return executionSets.resolveContext(request);
  }
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
    const binding = await service.getBinding({ ...originScope, taskId: request.parentSessionId });
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
    if (request.executionSetRef) {
      if (!executionSets || !sameScope(request.executionSetRef.origin, originScope))
        throw new Error("Execution set checkout source differs from the Agent workspace");
      const target = {
        ...originScope,
        executionSetId: request.executionSetRef.executionSetId,
        sessionId: request.sessionId,
      };
      const current = await executionSets.resolveContext(target);
      if (
        JSON.stringify(current.reference) !== JSON.stringify(request.executionSetRef) ||
        !sameScope(request, current.context.execution)
      )
        throw new Error("Execution set checkout reference has changed");
      try {
        const leases = await executionSets.acquireExecution(
          { ...target, ownerId: `${originKey}:${request.sessionId}` },
          service,
        );
        return {
          permitId: leases[0]!.token,
          additionalPermitIds: leases.slice(1).map((lease) => lease.token),
        };
      } catch (error) {
        if ((error as { code?: string }).code === "LCODE_CHECKOUT_BUSY") return { busy: true };
        throw error;
      }
    }
    if (request.repair) {
      const binding = await service.getBinding({
        ...originScope,
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
    } else {
      // 附着到执行目录的 client 与请求可同路径，不能据此绕过 restoring/deleting fence。
      // 无绑定的普通 local 会话仍可执行；一旦有绑定就必须由 owner 证明 ready 与精确 scope。
      const binding = await service.getBinding({ ...originScope, taskId: request.sessionId });
      if (
        binding
          ? binding.status !== "ready" || !sameScope(request, binding)
          : !sameScope(request, workspace)
      )
        throw new Error("Checkout writer scope does not match the task binding.");
    }
    try {
      // 根因：协议请求含 requestId/sessionId/repair，整体展开会被服务的严格 schema 拒绝，
      // 已接纳的输入因此在消息落盘前中断。按服务 contract 转换，关联和权限字段留在桥接层。
      const lease = await service.acquireCheckout({
        workspacePath: request.workspacePath,
        ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
        ownerId: `${originKey}:${request.sessionId}`,
        waitMs: 250,
        // 独占整轮执行会阻塞同一本地项目的其他会话。普通 runtime 共享执行；
        // 冻结集成目录的冲突修复仍独占，管理操作的缺省独占许可也保持不变。
        mode: request.repair ? "exclusive" : "shared",
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
    for (const token of [request.permitId, ...(request.additionalPermitIds ?? [])].reverse())
      await service.releaseCheckout({ token, ownerId: `${originKey}:${request.sessionId}` });
    return { released: true };
  }
  throw new Error("Unknown worktree request.");
}
