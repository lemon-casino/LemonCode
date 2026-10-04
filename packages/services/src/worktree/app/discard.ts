import type { WorktreeBinding, WorktreeIntegration, IWorktreeService } from "../contract.js";
import type { CheckoutCoordinator } from "../nodeTypes.js";
import type { WorktreeContext } from "./ports.js";
import { cleanupTemporaryTarget } from "./temporaryTarget.js";
import { removeManagedCheckout } from "./removeCheckout.js";

/** 永久删除由生命周期 owner 收口；保留绑定墓碑，防止旧客户端重新创建。 */
export function createWorktreeDiscard(
  context: WorktreeContext,
  coordinator: CheckoutCoordinator,
  ready: (binding: WorktreeBinding) => Promise<void>,
) {
  const { store, git } = context;
  type Request = Parameters<IWorktreeService["archive"]>[0];
  async function read(params: Request) {
    const value = await store.readBinding(params.bindingId);
    if (!value) throw new Error("Worktree binding not found");
    if (
      params.discard?.branch !== value.branch ||
      params.discard.checkoutPath !== value.checkoutPath
    )
      throw new Error("Worktree deletion confirmation does not match its binding");
    await store.assertManagedPath(value.checkoutPath);
    if (value.checkoutPath !== store.checkout(value.id) || !value.branch.startsWith("lcode/task-"))
      throw new Error("Worktree ownership does not permit task branch deletion");
    return value;
  }
  async function perform(params: Request, initialOperation?: WorktreeIntegration | null) {
    return store.lock(params.bindingId, async () => {
      let value = await read(params);
      if (value.status === "deleted") return value;
      if (value.latestIntegrationId !== initialOperation?.id)
        throw new Error("Worktree integration changed; refresh before deleting");
      const operation = initialOperation ? await store.readOperation(initialOperation.id) : null;
      if (
        operation &&
        ["preparing", "committing-source", "validating", "publishing"].includes(operation.status)
      )
        throw new Error("Worktree integration is running; stop it before deleting");
      const repository = await git.inspect(value.repositoryRoot);
      if (
        repository.root !== value.repositoryRoot ||
        repository.commonDirectory !== value.commonDirectory
      )
        throw new Error("Worktree repository ownership has changed");
      if (repository.branch === value.branch)
        throw new Error(
          "Task branch is checked out in the original project; switch branches before deleting",
        );
      const exists = await store.exists(value.checkoutPath);
      const registered = await git.registered(value.repositoryRoot, value.checkoutPath);
      if (exists) {
        if (!registered && !value.deletion && !value.snapshot)
          throw new Error("Worktree ownership is missing; preserve the existing directory");
        if (registered) await ready(value);
      }
      const lease = await coordinator.acquire({
        workspacePath: exists ? value.checkoutPath : value.repositoryRoot,
        ownerId: `discard:${params.requestId}`,
        waitMs: 250,
      });
      let integrationLease;
      try {
        // 取得许可后再检查目录与分支；Renderer 的 busy 标记不能替代真实 writer 判定。
        if (exists && registered) await ready(value);
        if (operation) {
          await store.assertManagedPath(operation.checkoutPath);
          if (operation.checkoutPath !== store.checkout(operation.id))
            throw new Error("Integration checkout path does not match its record");
          if (await store.exists(operation.checkoutPath)) {
            if (await git.registered(value.repositoryRoot, operation.checkoutPath)) {
              const info = await git.inspect(operation.checkoutPath);
              if (
                info.root !== operation.checkoutPath ||
                info.commonDirectory !== value.commonDirectory ||
                info.branch
              )
                throw new Error("Integration checkout ownership has changed");
            } else if (!value.deletion)
              throw new Error("Integration checkout ownership is missing");
            integrationLease = await coordinator.acquire({
              workspacePath: operation.checkoutPath,
              ownerId: `discard-integration:${params.requestId}`,
              waitMs: 250,
            });
          }
        }
        const ref = `refs/heads/${value.branch}`;
        const branchHead = await git.command(value.repositoryRoot, [
          "for-each-ref",
          "--format=%(objectname)",
          "--",
          ref,
        ]);
        if (value.deletion && branchHead && branchHead !== value.deletion.branchHead)
          throw new Error("Task branch changed during deletion; preserve the newer work");
        if (!value.deletion) {
          value = {
            ...value,
            status: "deleting",
            deletion: { requestId: params.requestId, branchHead: branchHead || undefined },
            updatedAt: new Date().toISOString(),
          };
          await store.saveBinding(value);
        }
        if (!value.deletion!.sessionIds) {
          // 先固定聊天清理范围；目录或 SQL 已删但回复丢失时仍可完成索引投影清理。
          const aliases = (await store.listAliases()).filter(
            (alias) => alias.bindingId === value.id,
          );
          const persisted = (await context.collectDiscardSessions?.(value)) ?? [];
          value = {
            ...value,
            deletion: {
              ...value.deletion!,
              sessionIds: [
                ...new Set([value.taskId, ...aliases.map((alias) => alias.taskId), ...persisted]),
              ],
            },
          };
          await store.saveBinding(value);
        }
        if (operation) {
          if (!["published", "cancelled", "failed"].includes(operation.status))
            await store.saveOperation({
              ...operation,
              status: "cancelled",
              updatedAt: new Date().toISOString(),
            });
          if (operation.targetTemporary && (await store.exists(operation.targetPath))) {
            const targetLease = await coordinator.acquire({
              workspacePath: operation.targetPath,
              ownerId: `discard-target:${params.requestId}`,
              waitMs: 250,
            });
            try {
              await cleanupTemporaryTarget(context, operation);
            } finally {
              await coordinator.release(targetLease);
            }
          }
          await removeManagedCheckout(context, {
            id: operation.id,
            checkoutPath: operation.checkoutPath,
            repositoryRoot: value.repositoryRoot,
          });
        }
        await removeManagedCheckout(context, value);
        await context.fault("discard.after-remove");
        const currentHead = await git.command(value.repositoryRoot, [
          "for-each-ref",
          "--format=%(objectname)",
          "--",
          ref,
        ]);
        if (currentHead && currentHead !== value.deletion!.branchHead)
          throw new Error("Task branch changed during deletion; preserve the newer work");
        // -D 只用于显式确认的受管任务分支；Git 仍拒绝删除被其他 checkout 占用的分支。
        if (currentHead)
          await git.command(value.repositoryRoot, ["branch", "-D", "--", value.branch]);
        for (const kind of ["worktree-snapshots", "worktree-indexes"])
          await git.command(value.repositoryRoot, [
            "update-ref",
            "-d",
            `refs/lcode/${kind}/${value.id}`,
          ]);
        await context.fault("discard.after-branch");
        await context.discardSessions?.(value, value.deletion!.sessionIds!);
        value = {
          ...value,
          status: "deleted",
          snapshot: undefined,
          forkSnapshot: undefined,
          error: undefined,
          updatedAt: new Date().toISOString(),
        };
        await store.saveBinding(value);
        return value;
      } catch (error) {
        // 部分删除是持久事实；具体错误必须可见，重试不能因目录/分支已消失而失效。
        if (value.deletion)
          await store.saveBinding({
            ...value,
            status: "deleting",
            error: error instanceof Error ? error.message : String(error),
            updatedAt: new Date().toISOString(),
          });
        throw error;
      } finally {
        if (integrationLease) await coordinator.release(integrationLease);
        await coordinator.release(lease);
      }
    });
  }
  return async (params: Request) => {
    const value = await read(params);
    if (value.status === "deleted") return value;
    // 与合并/发布采用相同的操作锁次序，取消后不允许在另一端继续发布候选。
    if (value.latestIntegrationId)
      return store.lock(value.latestIntegrationId, async () =>
        perform(params, await store.readOperation(value.latestIntegrationId!)),
      );
    return perform(params);
  };
}
