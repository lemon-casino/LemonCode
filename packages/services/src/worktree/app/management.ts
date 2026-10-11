import { randomUUID } from "node:crypto";
import type { WorktreeCleanupResult } from "@lcode/shared";
import type { WorktreeContext } from "./ports.js";

export function createWorktreeManagement(
  context: WorktreeContext,
  archive: (bindingId: string, requestId: string) => Promise<unknown>,
) {
  const { store } = context;
  return {
    getManagementSettings: store.getManagementSettings,
    updateManagementSettings: store.updateManagementSettings,
    async rename(params: { bindingId: string; displayName: string }) {
      return store.lock(params.bindingId, async () => {
        const binding = await store.readBinding(params.bindingId);
        if (!binding || binding.status === "deleted") throw new Error("Worktree binding not found");
        const renamed = {
          ...binding,
          displayName: params.displayName,
          updatedAt: new Date().toISOString(),
        };
        await store.saveBinding(renamed);
        return renamed;
      });
    },
    cleanup: (excludeId?: string) =>
      store.lock(store.key("worktree-retention"), async () => {
        const result: WorktreeCleanupResult = { archivedIds: [], skipped: [] };
        const settings = await store.getManagementSettings();
        if (!settings.autoDeleteEnabled) return result;
        const bindings = (await store.listBindings()).filter(
          (binding) => !["archived", "deleted"].includes(binding.status),
        );
        // 最旧工作树忙碌时保留超额数量，不能为了凑足上限转而归档最近的工作树。
        const candidates = bindings
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
          .slice(0, Math.max(0, bindings.length - settings.retainedCount));
        for (const binding of candidates) {
          if (binding.id === excludeId) continue;
          if (binding.status !== "ready") {
            result.skipped.push({ bindingId: binding.id, reason: `Worktree is ${binding.status}` });
            continue;
          }
          try {
            await archive(binding.id, `retention:${randomUUID()}`);
            result.archivedIds.push(binding.id);
          } catch (error) {
            result.skipped.push({
              bindingId: binding.id,
              reason: error instanceof Error ? error.message : String(error),
            });
          }
        }
        return result;
      }),
  };
}
