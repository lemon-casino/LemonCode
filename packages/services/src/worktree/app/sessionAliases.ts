import { resolve } from "node:path";
import type { WorktreeBinding, WorktreePrepareRequest } from "../contract.js";
import type { WorktreeContext } from "./ports.js";

export async function registerWorktreeSessionAlias(
  context: WorktreeContext,
  params: WorktreePrepareRequest,
  id: string,
  ready: (binding: WorktreeBinding) => Promise<void>,
) {
  const parent = params.parentBinding;
  if (!parent) throw new Error("Parent binding is required for a forked session");
  if (id === parent.bindingId) throw new Error("Fork child must have its own task ID");
  if (
    params.baseRef ||
    params.sourceFolderPaths ||
    params.setupCommands ||
    params.copyIgnoredPaths ||
    params.retrySetup
  )
    throw new Error("Forked sessions inherit their existing worktree environment");
  return context.store.lock(id, async () => {
    return context.store.lock(parent.bindingId, async () => {
      const binding = await context.store.readBinding(parent.bindingId);
      const scopeKey = params.workspaceIdentity?.trim() || resolve(params.workspacePath);
      if (
        !binding ||
        binding.status !== "ready" ||
        binding.taskId !== parent.bindingOwnerTaskId ||
        (binding.originalWorkspaceIdentity?.trim() || resolve(binding.originalWorkspacePath)) !==
          scopeKey
      )
        throw new Error("Fork parent binding does not belong to the original workspace");
      await ready(binding);
      if (params.taskId === binding.taskId || params.taskId === parent.parentTaskId)
        throw new Error("Fork child must have its own task ID");
      const parentAlias = (await context.store.listAliases()).find(
        (alias) => alias.taskId === parent.parentTaskId && alias.originalKey === scopeKey,
      );
      if (parent.parentTaskId !== binding.taskId && parentAlias?.bindingId !== binding.id)
        throw new Error("Fork parent is not registered to this worktree");
      const owned = await context.store.readBinding(id);
      if (owned) throw new Error("Child task already owns an independent worktree");
      const existing = await context.store.readAlias(id);
      if (
        existing &&
        (existing.bindingId !== binding.id || existing.parentTaskId !== parent.parentTaskId)
      )
        throw new Error("A forked session cannot change its worktree or parent binding");
      if (!existing)
        await context.store.saveAlias({
          id,
          taskId: params.taskId,
          parentTaskId: parent.parentTaskId,
          bindingId: binding.id,
          originalKey: scopeKey,
          executionKey: binding.workspaceIdentity?.trim() || resolve(binding.workspacePath),
        });
      return binding;
    });
  });
}
