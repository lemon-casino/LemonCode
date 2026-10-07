import { runtimeEnvironmentBindingReferenceSchema } from "@lcode/shared";
import type { IWorktreeHostService, WorktreeBinding } from "../contract.js";
import type { CheckoutCoordinator } from "../nodeTypes.js";
import type { WorktreeContext } from "./ports.js";
import { rebuildBindingRuntime, releaseBindingRuntime, sameEnvironment } from "./runtimeEnvironment.js";

export function createWorktreeEnvironmentUpgrade(context: WorktreeContext, coordinator: CheckoutCoordinator, ready: (binding: WorktreeBinding) => Promise<void>): IWorktreeHostService["upgradeRuntimeEnvironment"] {
  const { store } = context;
  return async (params) => {
    if (!params.requestId.trim()) throw new Error("Environment upgrade request ID is required");
    runtimeEnvironmentBindingReferenceSchema.parse(params.expectedEnvironmentRef);
    const cancelKey = store.key(`environment-upgrade:${params.bindingId}:${params.requestId}`);
    // 取消不能排在长时间 prepare 的 binding 锁后；独立标记由末尾短 decision lock 裁决。
    if (params.cancel) {
      const binding = await store.lock(cancelKey, async () => {
        const current = await store.readBinding(params.bindingId);
        if (!current || current.environmentUpgrade?.requestId !== params.requestId || !sameEnvironment(current.environmentRebuild?.oldEnvironmentRef, params.expectedEnvironmentRef))
          throw new Error("Environment upgrade cancellation does not match its owner");
        if (current.status === "ready") return current;
        await store.cancelPreparation(cancelKey);
        return current;
      });
      if (binding.status === "ready") return binding;
      if (!context.prepareRuntimeEnvironment) throw new Error("Managed environment preparation port is unavailable");
      try {
        await context.prepareRuntimeEnvironment({ bindingId: binding.id, checkoutPath: binding.checkoutPath, requestId: params.requestId, purpose: "worktree", operation: "upgrade", cancel: true, environmentId: params.expectedEnvironmentRef.environmentId, expectedRevision: params.expectedEnvironmentRef.revision, expectedManifestDigest: params.expectedEnvironmentRef.manifestDigest });
      } catch (error) {
        // runtime port 的 cancelled/running 是取消收据，不是可执行 ready；保留原 binding fence。
        const operation = error && typeof error === "object" && "operation" in error ? error.operation : undefined;
        if (!operation || typeof operation !== "object" || !("status" in operation) || !["cancelled", "running"].includes(String(operation.status))) throw error;
      }
      return (await store.readBinding(binding.id)) ?? binding;
    }
    return store.lock(params.bindingId, async () => {
      let value = await store.readBinding(params.bindingId);
      if (!value) throw new Error("Worktree binding not found");
      if (value.environmentUpgrade?.requestId === params.requestId && value.status === "ready") {
        if (!sameEnvironment(value.environmentRebuild?.oldEnvironmentRef, params.expectedEnvironmentRef)) throw new Error("Environment upgrade request ID cannot change its expected reference");
        return value;
      }
      if (!["ready", "updating"].includes(value.status)) throw new Error("Worktree is not ready for an environment upgrade");
      if (value.status === "updating" && value.environmentUpgrade?.requestId !== params.requestId)
        throw new Error("Finish the existing environment upgrade before starting another");
      const oldReference = value.status === "updating" ? value.environmentRebuild?.oldEnvironmentRef : value.environmentRef;
      if (!oldReference || !sameEnvironment(oldReference, params.expectedEnvironmentRef)) throw new Error("Environment upgrade reference is stale");
      await ready(value);
      if (!context.prepareRuntimeEnvironment || !context.resolveRuntimeEnvironment || !context.releaseRuntimeEnvironment || !context.rebindRuntimeEnvironmentSessions)
        throw new Error("Managed environment upgrade capability is unavailable");
      if (await store.isPreparationCancelled(cancelKey)) throw new Error("Environment upgrade was cancelled");
      if (value.status !== "updating") {
        value = { ...value, status: "updating", error: undefined, environmentUpgrade: { requestId: params.requestId }, environmentRebuild: { oldEnvironmentId: oldReference.environmentId, oldEnvironmentRef: oldReference, status: "pending" } };
        await store.saveBinding(value);
      }
      let lease;
      try {
        if (!value.environmentRebuild?.newEnvironmentRef) {
          await releaseBindingRuntime(context, value, params.requestId, "upgrade", "fence");
          await releaseBindingRuntime(context, value, params.requestId, "upgrade", "stop");
        }
        lease = await coordinator.acquire({ workspacePath: value.checkoutPath, ownerId: `upgrade:${value.id}:${params.requestId}`, waitMs: 250 });
        await ready(value);
        value = await rebuildBindingRuntime(context, value, params.requestId, "upgrade", lease);
        return await store.lock(cancelKey, async () => {
          if (await store.isPreparationCancelled(cancelKey)) throw new Error("Environment upgrade was cancelled");
          const completed: WorktreeBinding = { ...value!, status: "ready", error: undefined, updatedAt: new Date().toISOString() };
          await store.saveBinding(completed);
          return completed;
        });
      } catch (error) {
        const latest = (await store.readBinding(params.bindingId)) ?? value;
        await store.saveBinding({ ...latest, status: "updating", environmentRebuild: { ...latest.environmentRebuild, status: "failed" }, error: error instanceof Error ? error.message : String(error), updatedAt: new Date().toISOString() });
        throw error;
      } finally {
        if (lease) await coordinator.release(lease);
      }
    });
  };
}
