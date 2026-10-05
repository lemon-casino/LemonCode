import { resolve } from "node:path";
import type { WorktreeBinding, WorktreeScope } from "../contract.js";
import type { WorktreeContext } from "./ports.js";

/** 绑定身份键：identity key（identity 优先）+ taskId 的稳定哈希。 */
export function bindingKey(context: WorktreeContext, scope: WorktreeScope & { taskId: string }) {
  return context.store.key(
    JSON.stringify([scope.workspaceIdentity?.trim() || resolve(scope.workspacePath), scope.taskId]),
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
    params: WorktreeScope & { taskId?: string; requestId?: string },
  ): Promise<WorktreeBinding | null> {
    const identity = params.workspaceIdentity?.trim() || resolve(params.workspacePath);
    if (!params.taskId) {
      const id = params.requestId
        ? await store.readPreparationRequest(identity, params.requestId)
        : null;
      if (!id) return null;
      const binding = await store.readBinding(id);
      if (
        !binding ||
        binding.requestId !== params.requestId ||
        (binding.originalWorkspaceIdentity?.trim() || resolve(binding.originalWorkspacePath)) !==
          identity
      )
        throw new Error("Preparation request scope mismatch");
      return {
        ...binding,
        preparation: binding.preparation
          ? { ...binding.preparation, cancelRequested: await store.isPreparationCancelled(id) }
          : undefined,
      };
    }
    let binding =
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
