import type { WorktreeBinding } from "../contract.js";
import type { CheckoutCoordinator } from "../nodeTypes.js";
import type { WorktreeContext } from "./ports.js";

export function createWorktreeArchive(
  context: WorktreeContext,
  coordinator: CheckoutCoordinator,
  ready: (binding: WorktreeBinding) => Promise<void>,
) {
  const { store, git } = context;
  async function binding(id: string) {
    const value = await store.readBinding(id);
    if (!value) throw new Error("Worktree binding not found");
    await store.assertManagedPath(value.checkoutPath);
    if (value.checkoutPath !== store.checkout(value.id))
      throw new Error("Managed worktree record path does not match its ID");
    if (value.latestIntegrationId) {
      const operation = await store.readOperation(value.latestIntegrationId);
      if (operation && !["published", "failed", "cancelled"].includes(operation.status))
        throw new Error("Resolve or finish the integration before archiving");
    }
    return value;
  }
  async function archive(params: {
    bindingId: string;
    requestId: string;
    acknowledgeIgnoredFiles?: boolean;
  }) {
    if (!params.requestId.trim()) throw new Error("Archive request ID is required");
    const original = await binding(params.bindingId);
    if (original.status === "archived") return original;
    if (!(await store.exists(original.checkoutPath))) {
      if (!original.snapshot) throw new Error("Missing worktree has no saved archive snapshot");
      return store.lock(original.id, async () => {
        const archived = {
          ...(await binding(original.id)),
          status: "archived" as const,
          updatedAt: new Date().toISOString(),
        };
        await store.saveBinding(archived);
        return archived;
      });
    }
    return store.lock(original.id, async () => {
      let value = await binding(original.id);
      if (value.status === "archived") return value;
      const lease = await coordinator.acquire({
        workspacePath: value.checkoutPath,
        ownerId: `archive:${params.requestId}`,
      });
      try {
        await ready(value);
        const snapshot = await git.snapshot(value, Boolean(params.acknowledgeIgnoredFiles));
        value = { ...value, snapshot, updatedAt: new Date().toISOString() };
        await store.saveBinding(value);
        await context.fault("archive.after-snapshot");
        await ready(value);
        if (!(await git.matchesSnapshot(value, true)))
          throw new Error(
            "Worktree changed after its archive snapshot; preserve changes and retry",
          );
        await git.command(value.repositoryRoot, [
          "worktree",
          "remove",
          "--force",
          value.checkoutPath,
        ]);
        await context.fault("archive.after-remove");
        value = { ...value, status: "archived", updatedAt: new Date().toISOString() };
        await store.saveBinding(value);
        return value;
      } finally {
        await coordinator.release(lease);
      }
    });
  }
  async function restore(params: { bindingId: string; requestId: string }) {
    if (!params.requestId.trim()) throw new Error("Restore request ID is required");
    return store.lock(params.bindingId, async () => {
      let value = await binding(params.bindingId);
      if (value.status === "ready") {
        await ready(value);
        return value;
      }
      if (!value.snapshot || !["archived", "restoring"].includes(value.status))
        throw new Error("Worktree is not an archived snapshot");
      const snapshotHead = value.snapshot.head;
      const head = await git.command(value.repositoryRoot, [
        "rev-parse",
        "--verify",
        `refs/heads/${value.branch}`,
      ]);
      if (head !== value.snapshot.head)
        throw new Error("Archived task branch changed; restore would overwrite newer work");
      const exists = await store.exists(value.checkoutPath);
      if (exists && value.status !== "restoring")
        throw new Error("Restore destination already exists");
      value = { ...value, status: "restoring", updatedAt: new Date().toISOString() };
      await store.saveBinding(value);
      if (!exists)
        await git.command(value.repositoryRoot, [
          "worktree",
          "add",
          value.checkoutPath,
          value.branch,
        ]);
      const lease = await coordinator.acquire({
        workspacePath: value.checkoutPath,
        ownerId: `restore:${params.requestId}`,
      });
      try {
        await ready(value);
        if (exists && (await git.matchesSnapshot(value))) {
          value = {
            ...value,
            status: "ready",
            updatedAt: new Date().toISOString(),
            error: undefined,
          };
          await store.saveBinding(value);
          return value;
        }
        await context.fault("restore.after-add");
        // 取得写许可后再核对目录，避免等待许可期间的外部修改被快照恢复覆盖。
        if (
          await git.command(value.checkoutPath, ["status", "--porcelain", "--untracked-files=all"])
        )
          throw new Error(
            "Interrupted restore contains changes; preserve and inspect it before retrying",
          );
        if ((await git.command(value.checkoutPath, ["rev-parse", "HEAD"])) !== snapshotHead)
          throw new Error("Restore checkout HEAD changed; preserve and inspect it before retrying");
        await git.restoreFiles(value);
        await context.fault("restore.after-files");
        value = {
          ...value,
          status: "ready",
          updatedAt: new Date().toISOString(),
          error: undefined,
        };
        await store.saveBinding(value);
        return value;
      } finally {
        await coordinator.release(lease);
      }
    });
  }
  return { archive, restore };
}
