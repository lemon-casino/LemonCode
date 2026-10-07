import type { CheckoutLease, WorktreeBinding, WorktreeIntegration, IWorktreeService } from "../contract.js";
import type { CheckoutCoordinator } from "../nodeTypes.js";
import type { WorktreeContext } from "./ports.js";
import { cleanupTemporaryTarget } from "./temporaryTarget.js";
import { removeManagedCheckout } from "./removeCheckout.js";
import { releaseBindingRuntime } from "./runtimeEnvironment.js";

/** 永久删除由生命周期 owner 收口；先阻止新消费者、停止真实进程，最后提交删除墓碑。 */
export function createWorktreeDiscard(context: WorktreeContext, coordinator: CheckoutCoordinator, ready: (binding: WorktreeBinding) => Promise<void>) {
  const { store, git } = context;
  type Request = Parameters<IWorktreeService["archive"]>[0];
  async function read(params: Request) {
    const value = await store.readBinding(params.bindingId);
    if (!value) throw new Error("Worktree binding not found");
    if (params.discard?.branch !== value.branch || params.discard.checkoutPath !== value.checkoutPath)
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
      if (value.latestIntegrationId !== initialOperation?.id) throw new Error("Worktree integration changed; refresh before deleting");
      const operation = initialOperation ? await store.readOperation(initialOperation.id) : null;
      if (operation && ["preparing", "committing-source", "validating", "publishing"].includes(operation.status))
        throw new Error("Worktree integration is running; stop it before deleting");
      const repository = await git.inspect(value.repositoryRoot);
      if (repository.root !== value.repositoryRoot || repository.commonDirectory !== value.commonDirectory)
        throw new Error("Worktree repository ownership has changed");
      if (repository.branch === value.branch) throw new Error("Task branch is checked out in the original project; switch branches before deleting");
      const exists = await store.exists(value.checkoutPath);
      const registered = await git.registered(value.repositoryRoot, value.checkoutPath);
      if (exists) {
        if (!registered && !value.deletion && !value.snapshot) throw new Error("Worktree ownership is missing; preserve the existing directory");
        if (registered) await ready(value);
      }
      if (operation) {
        await store.assertManagedPath(operation.checkoutPath);
        if (operation.checkoutPath !== store.checkout(operation.id)) throw new Error("Integration checkout path does not match its record");
        if (await store.exists(operation.checkoutPath)) {
          if (await git.registered(value.repositoryRoot, operation.checkoutPath)) {
            const info = await git.inspect(operation.checkoutPath);
            if (info.root !== operation.checkoutPath || info.commonDirectory !== value.commonDirectory || info.branch)
              throw new Error("Integration checkout ownership has changed");
          } else if (!value.deletion) throw new Error("Integration checkout ownership is missing");
        }
      }
      const ref = `refs/heads/${value.branch}`;
      const branchHead = await git.command(value.repositoryRoot, ["for-each-ref", "--format=%(objectname)", "--", ref]);
      if (value.deletion && branchHead && branchHead !== value.deletion.branchHead)
        throw new Error("Task branch changed during deletion; preserve the newer work");
      if (!value.deletion) {
        value = { ...value, status: "deleting", deletion: { requestId: params.requestId, branchHead: branchHead || undefined }, updatedAt: new Date().toISOString() };
        await store.saveBinding(value);
      }
      const requestId = value.deletion!.requestId;
      let lease: CheckoutLease | undefined;
      let integrationLease: CheckoutLease | undefined;
      try {
        if ((value.environmentRef && (!context.collectDiscardSessions || !context.discardSessions)) || Boolean(context.collectDiscardSessions) !== Boolean(context.discardSessions))
          throw new Error("Worktree session cleanup ports are unavailable");
        // collect 的生产实现也会 closeSessions/disposeWorkspace；它必须位于 fence 之后，不能被当纯查询提前执行。
        await releaseBindingRuntime(context, value, requestId, "discard", "fence");
        if (operation?.environmentRef) await releaseBindingRuntime(context, value, requestId, "candidate-cancel", "fence", operation);
        let collected: string[] | undefined;
        if (!value.deletion!.sessionIds) {
          collected = context.collectDiscardSessions ? await context.collectDiscardSessions(value) : [value.taskId, ...(await store.listAliases()).filter((alias) => alias.bindingId === value.id).map((alias) => alias.taskId)];
        }
        await releaseBindingRuntime(context, value, requestId, "discard", "stop");
        if (operation?.environmentRef) await releaseBindingRuntime(context, value, requestId, "candidate-cancel", "stop", operation);
        if (collected) {
          value = { ...value, deletion: { ...value.deletion!, sessionIds: [...new Set(collected)] } };
          await store.saveBinding(value);
        }
        await context.fault("discard.after-stop");
        lease = await coordinator.acquire({ workspacePath: await store.exists(value.checkoutPath) ? value.checkoutPath : value.repositoryRoot, ownerId: `discard:${requestId}`, waitMs: 250 });
        if (await store.exists(value.checkoutPath) && await git.registered(value.repositoryRoot, value.checkoutPath)) await ready(value);
        if (operation && await store.exists(operation.checkoutPath))
          integrationLease = await coordinator.acquire({ workspacePath: operation.checkoutPath, ownerId: `discard-integration:${requestId}`, waitMs: 250 });
        const checkedHead = await git.command(value.repositoryRoot, ["for-each-ref", "--format=%(objectname)", "--", ref]);
        if (checkedHead && checkedHead !== value.deletion!.branchHead) throw new Error("Task branch changed during deletion; preserve the newer work");
        // 先持久删除精确 entry/聊天，再删除文件。purge 失败时用户文件仍可恢复；回复丢失只重入已 journal 的 IDs。
        await context.discardSessions?.(value, value.deletion!.sessionIds!);
        await context.fault("discard.after-sessions");
        if (operation) {
          if (!["published", "cancelled", "failed"].includes(operation.status))
            await store.saveOperation({ ...operation, status: "cancelled", updatedAt: new Date().toISOString() });
          if (operation.targetTemporary && await store.exists(operation.targetPath)) {
            const targetLease = await coordinator.acquire({ workspacePath: operation.targetPath, ownerId: `discard-target:${requestId}`, waitMs: 250 });
            try { await cleanupTemporaryTarget(context, operation); } finally { await coordinator.release(targetLease); }
          }
          await removeManagedCheckout(context, { id: operation.id, checkoutPath: operation.checkoutPath, repositoryRoot: value.repositoryRoot });
        }
        await removeManagedCheckout(context, value);
        await context.fault("discard.after-remove");
        const currentHead = await git.command(value.repositoryRoot, ["for-each-ref", "--format=%(objectname)", "--", ref]);
        if (currentHead && currentHead !== value.deletion!.branchHead) throw new Error("Task branch changed during deletion; preserve the newer work");
        if (currentHead) await git.command(value.repositoryRoot, ["branch", "-D", "--", value.branch]);
        for (const kind of ["worktree-snapshots", "worktree-indexes"])
          await git.command(value.repositoryRoot, ["update-ref", "-d", `refs/lcode/${kind}/${value.id}`]);
        await context.fault("discard.after-branch");
        for (const phase of ["cleanup", "finalize"] as const) {
          if (operation?.environmentRef) await releaseBindingRuntime(context, value, requestId, "candidate-cancel", phase, operation);
          await releaseBindingRuntime(context, value, requestId, "discard", phase);
        }
        value = { ...value, status: "deleted", snapshot: undefined, forkSnapshot: undefined, error: undefined, updatedAt: new Date().toISOString() };
        await store.saveBinding(value);
        return value;
      } catch (error) {
        await store.saveBinding({ ...value, status: "deleting", error: error instanceof Error ? error.message : String(error), updatedAt: new Date().toISOString() });
        throw error;
      } finally {
        if (integrationLease) await coordinator.release(integrationLease);
        if (lease) await coordinator.release(lease);
      }
    });
  }
  return async (params: Request) => {
    const value = await read(params);
    if (value.status === "deleted") return value;
    if (value.latestIntegrationId)
      return store.lock(value.latestIntegrationId, async () => perform(params, await store.readOperation(value.latestIntegrationId!)));
    return perform(params);
  };
}
