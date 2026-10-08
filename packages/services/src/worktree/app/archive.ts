import type { CheckoutLease, WorktreeBinding } from "../contract.js";
import type { CheckoutCoordinator } from "../nodeTypes.js";
import type { WorktreeContext } from "./ports.js";
import { createWorktreeDiscard } from "./discard.js";
import { removeManagedCheckout } from "./removeCheckout.js";
import {
  rebuildBindingRuntime,
  releaseBindingRuntime,
  resolveBindingRuntime,
} from "./runtimeEnvironment.js";

export function createWorktreeArchive(
  context: WorktreeContext,
  coordinator: CheckoutCoordinator,
  ready: (binding: WorktreeBinding) => Promise<void>,
) {
  const { store, git } = context;
  const discard = createWorktreeDiscard(context, coordinator, ready);
  async function binding(id: string) {
    const value = await store.readBinding(id);
    if (!value) throw new Error("Worktree binding not found");
    await store.assertManagedPath(value.checkoutPath);
    if (value.checkoutPath !== store.checkout(value.id))
      throw new Error("Managed worktree record path does not match its ID");
    if (value.latestIntegrationId) {
      const operation = await store.readOperation(value.latestIntegrationId);
      if (
        operation &&
        !["published", "up-to-date", "failed", "cancelled"].includes(operation.status)
      )
        throw new Error("Resolve or finish the integration before archiving");
    }
    return value;
  }
  async function archive(params: {
    bindingId: string;
    requestId: string;
    acknowledgeIgnoredFiles?: boolean;
    discard?: { branch: string; checkoutPath: string };
  }) {
    if (!params.requestId.trim()) throw new Error("Archive request ID is required");
    if (params.discard) return discard(params);
    return store.lock(params.bindingId, async () => {
      let value = await binding(params.bindingId);
      if (["deleting", "deleted"].includes(value.status))
        throw new Error("Worktree has been deleted; create a new task");
      if (value.status === "archived") return value;
      if (["restoring", "updating"].includes(value.status))
        throw new Error("Finish the pending environment operation before archiving");
      if (!(await store.exists(value.checkoutPath)) && !value.snapshot)
        throw new Error("Missing worktree has no saved archive snapshot");
      // 归档有自己的可恢复 journal，绝不能复用永久删除 fence 或释放持久 session 引用。
      value = {
        ...value,
        status: "archiving",
        archiveOperation: value.archiveOperation ?? { requestId: params.requestId },
        updatedAt: new Date().toISOString(),
      };
      await store.saveBinding(value);
      const requestId = value.archiveOperation!.requestId;
      let lease: CheckoutLease | undefined;
      try {
        await releaseBindingRuntime(context, value, requestId, "archive", "fence");
        await releaseBindingRuntime(context, value, requestId, "archive", "stop");
        const exists = await store.exists(value.checkoutPath);
        lease = await coordinator.acquire({
          workspacePath: exists ? value.checkoutPath : value.repositoryRoot,
          ownerId: `archive:${requestId}`,
          waitMs: 250,
        });
        if (exists && (await git.registered(value.repositoryRoot, value.checkoutPath))) {
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
        } else {
          if (!value.snapshot) throw new Error("Managed worktree registration is missing");
          const repository = await git.inspect(value.repositoryRoot);
          if (
            repository.root !== value.repositoryRoot ||
            repository.commonDirectory !== value.commonDirectory
          )
            throw new Error("Worktree repository ownership has changed");
          const head = await git.command(value.repositoryRoot, [
            "for-each-ref",
            "--format=%(objectname)",
            "--",
            `refs/heads/${value.branch}`,
          ]);
          if (head && head !== value.snapshot.head)
            throw new Error("Archived task branch changed; preserve the newer work");
        }
        await removeManagedCheckout(context, value);
        await context.fault("archive.after-remove");
        await releaseBindingRuntime(context, value, requestId, "archive", "cleanup");
        await releaseBindingRuntime(context, value, requestId, "archive", "finalize");
        value = {
          ...value,
          status: "archived",
          error: undefined,
          updatedAt: new Date().toISOString(),
        };
        await store.saveBinding(value);
        return value;
      } catch (error) {
        await store.saveBinding({
          ...value,
          status: "archiving",
          error: error instanceof Error ? error.message : String(error),
          updatedAt: new Date().toISOString(),
        });
        throw error;
      } finally {
        if (lease) await coordinator.release(lease);
      }
    });
  }
  async function restore(params: { bindingId: string; requestId: string }) {
    if (!params.requestId.trim()) throw new Error("Restore request ID is required");
    return store.lock(params.bindingId, async () => {
      let value = await binding(params.bindingId);
      if (["deleting", "deleted"].includes(value.status))
        throw new Error("Worktree has been deleted; create a new task");
      if (value.status === "ready") {
        await ready(value);
        await resolveBindingRuntime(context, value);
        return value;
      }
      if (!value.snapshot || !["archived", "restoring"].includes(value.status))
        throw new Error("Worktree is not an archived snapshot");
      const snapshotHead = value.snapshot.head;
      const head = await git.command(value.repositoryRoot, [
        "for-each-ref",
        "--format=%(objectname)",
        "--",
        `refs/heads/${value.branch}`,
      ]);
      if (head && head !== snapshotHead)
        throw new Error("Archived task branch changed; restore would overwrite newer work");
      const exists = await store.exists(value.checkoutPath);
      if (exists && value.status !== "restoring")
        throw new Error("Restore destination already exists");
      const continuing = value.status === "restoring";
      const oldReference = continuing
        ? (value.environmentRebuild?.oldEnvironmentRef ?? value.environmentRef)
        : value.environmentRef;
      value = {
        ...value,
        status: "restoring",
        restoration:
          continuing && value.restoration ? value.restoration : { requestId: params.requestId },
        environmentRebuild: continuing
          ? value.environmentRebuild
          : oldReference
            ? {
                oldEnvironmentId: oldReference.environmentId,
                oldEnvironmentRef: oldReference,
                status: "pending",
              }
            : undefined,
        updatedAt: new Date().toISOString(),
      };
      await store.saveBinding(value);
      const requestId = value.restoration!.requestId;
      let lease: CheckoutLease | undefined;
      try {
        if (!exists)
          await git.command(value.repositoryRoot, [
            "worktree",
            "add",
            ...(!head ? ["-b", value.branch] : []),
            value.checkoutPath,
            head ? value.branch : snapshotHead,
          ]);
        lease = await coordinator.acquire({
          workspacePath: value.checkoutPath,
          ownerId: `restore:${requestId}`,
          waitMs: 250,
        });
        await ready(value);
        if (!(exists && (await git.matchesSnapshot(value)))) {
          await context.fault("restore.after-add");
          if (
            await git.command(value.checkoutPath, [
              "status",
              "--porcelain",
              "--untracked-files=all",
            ])
          )
            throw new Error(
              "Interrupted restore contains changes; preserve and inspect it before retrying",
            );
          if ((await git.command(value.checkoutPath, ["rev-parse", "HEAD"])) !== snapshotHead)
            throw new Error(
              "Restore checkout HEAD changed; preserve and inspect it before retrying",
            );
          await git.restoreFiles(value);
          await context.fault("restore.after-files");
        }
        // 首次恢复与 Git 已完成的重试都走同一环境/会话 CAS，不能有直接 ready 快路径。
        value = await rebuildBindingRuntime(context, value, requestId, "restore", lease);
        value = {
          ...value,
          status: "ready",
          archiveOperation: undefined,
          error: undefined,
          updatedAt: new Date().toISOString(),
        };
        await store.saveBinding(value);
        return value;
      } catch (error) {
        const latest = (await store.readBinding(value.id)) ?? value;
        await store.saveBinding({
          ...latest,
          status: "restoring",
          environmentRebuild: oldReference
            ? { ...latest.environmentRebuild, status: "failed" }
            : latest.environmentRebuild,
          error: error instanceof Error ? error.message : String(error),
          updatedAt: new Date().toISOString(),
        });
        throw error;
      } finally {
        if (lease) await coordinator.release(lease);
      }
    });
  }
  return { archive, restore };
}
