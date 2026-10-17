import { resolve } from "node:path";
import type { WorktreeBinding, WorktreeScope } from "../contract.js";
import type { BindingOwnerRef } from "@lcode/shared";
import type { WorktreeContext } from "./ports.js";

/** 绑定身份键：identity key（identity 优先）+ taskId 的稳定哈希。 */
export function bindingKey(
  context: WorktreeContext,
  scope: WorktreeScope & { taskId?: string; ownerRef?: BindingOwnerRef },
) {
  const owner =
    scope.ownerRef?.kind === "executionSet"
      ? ["executionSet", scope.ownerRef.executionSetId, scope.ownerRef.repositoryId]
      : scope.taskId;
  if (!owner) throw new Error("Worktree requires an explicit binding owner");
  return context.store.key(
    JSON.stringify([scope.workspaceIdentity?.trim() || resolve(scope.workspacePath), owner]),
  );
}

/**
 * 绑定查询（从 lifecycle.ts 抽出以守住 400 行上限）。
 * 只读查询：requestId 维度校验作用域，taskId 维度支持别名回退与 missing 投影。
 */
export function createWorktreeBindingLookup(
  context: WorktreeContext,
  ready: (binding: WorktreeBinding) => Promise<void>,
) {
  const { store } = context;
  return async function getBinding(
    params: WorktreeScope & { taskId?: string; requestId?: string; bindingId?: string },
  ): Promise<WorktreeBinding | null> {
    const identity = params.workspaceIdentity?.trim() || resolve(params.workspacePath);
    let binding: WorktreeBinding | undefined;
    if (params.bindingId) {
      if (params.taskId || params.requestId)
        throw new Error("Choose exactly one binding lookup key");
      binding = (await store.readBinding(params.bindingId)) ?? undefined;
      // 工作集资源没有伪造会话；按真实绑定 ID 查询仍须核对完整来源或执行身份。
      if (
        binding &&
        ![
          binding.originalWorkspaceIdentity?.trim() || resolve(binding.originalWorkspacePath),
          binding.workspaceIdentity?.trim() || resolve(binding.workspacePath),
        ].includes(identity)
      )
        throw new Error("Binding lookup scope mismatch");
    } else if (!params.taskId) {
      const id = params.requestId
        ? await store.readPreparationRequest(identity, params.requestId)
        : null;
      if (!id) return null;
      let binding = await store.readBinding(id);
      const alias = binding ? null : await store.readAlias(id);
      if (alias?.originalKey === identity) binding = await store.readBinding(alias.bindingId);
      if (
        !binding ||
        (!alias && binding.requestId !== params.requestId) ||
        (binding.originalWorkspaceIdentity?.trim() || resolve(binding.originalWorkspacePath)) !==
          identity
      )
        throw new Error("Preparation request scope mismatch");
      return {
        ...binding,
        preparation: binding.preparation
          ? {
              ...binding.preparation,
              cancelRequested: await store.isPreparationCancelled(binding.id),
            }
          : undefined,
      };
    } else {
      binding =
        (await store.readBinding(bindingKey(context, { ...params, taskId: params.taskId }))) ??
        (await store.listBindings()).find(
          (candidate) =>
            candidate.taskId === params.taskId &&
            (candidate.workspaceIdentity?.trim() || resolve(candidate.workspacePath)) === identity,
        );
      if (!binding) {
        const alias = (await store.listAliases()).find(
          (entry) =>
            entry.taskId === params.taskId &&
            [entry.originalKey, entry.executionKey].includes(identity),
        );
        if (alias) binding = (await store.readBinding(alias.bindingId)) ?? undefined;
      }
    }
    // 删除墓碑与归档同样不检查已释放的目录，仅实际执行状态需要校验 checkout。
    if (!binding || !["ready", "restoring", "missing"].includes(binding.status)) {
      if (binding?.preparation)
        binding = {
          ...binding,
          preparation: {
            ...binding.preparation,
            cancelRequested: await store.isPreparationCancelled(binding.id),
          },
        };
      return binding ?? null;
    }
    try {
      await ready(binding);
      return binding;
    } catch (error) {
      return {
        ...binding,
        status: "missing" as const,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };
}
