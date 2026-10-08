import { runtimeEnvironmentBindingReferenceSchema } from "@lcode/shared";
import type {
  IWorktreeHostService,
  WorktreeBinding,
  PreparedWorktreeRuntime,
} from "../contract.js";
import type { CheckoutCoordinator } from "../nodeTypes.js";
import type { WorktreeContext } from "./ports.js";
import {
  rebuildBindingRuntime,
  releaseBindingRuntime,
  sameEnvironment,
  environmentReference,
} from "./runtimeEnvironment.js";

export function createWorktreeEnvironmentUpgrade(
  context: WorktreeContext,
  coordinator: CheckoutCoordinator,
  ready: (binding: WorktreeBinding) => Promise<void>,
): IWorktreeHostService["upgradeRuntimeEnvironment"] {
  const { store } = context;
  const cancellationKey = (bindingId: string, requestId: string) =>
    store.key(`environment-upgrade:${bindingId}:${requestId}`);
  return async (params) => {
    if (!params.requestId.trim()) throw new Error("Environment upgrade request ID is required");
    runtimeEnvironmentBindingReferenceSchema.parse(params.expectedEnvironmentRef);
    const cancelKey = cancellationKey(params.bindingId, params.requestId);
    // 取消不能排在长时间 prepare 的 binding 锁后；独立标记由末尾短 decision lock 裁决。
    if (params.cancel) {
      const binding = await store.lock(cancelKey, async () => {
        const current = await store.readBinding(params.bindingId);
        if (
          !current ||
          current.environmentUpgrade?.requestId !== params.requestId ||
          !sameEnvironment(
            current.environmentRebuild?.oldEnvironmentRef,
            params.expectedEnvironmentRef,
          )
        )
          throw new Error("Environment upgrade cancellation does not match its owner");
        if (current.status === "ready") return current;
        await store.cancelPreparation(cancelKey);
        return current;
      });
      if (binding.status === "ready") return binding;
      if (!context.prepareRuntimeEnvironment)
        throw new Error("Managed environment preparation port is unavailable");
      let committed: PreparedWorktreeRuntime | undefined;
      try {
        committed = await context.prepareRuntimeEnvironment({
          bindingId: binding.id,
          checkoutPath: binding.checkoutPath,
          requestId: params.requestId,
          purpose: "worktree",
          operation: "upgrade",
          cancel: true,
          environmentId: params.expectedEnvironmentRef.environmentId,
          expectedRevision: params.expectedEnvironmentRef.revision,
          expectedManifestDigest: params.expectedEnvironmentRef.manifestDigest,
        });
      } catch (error) {
        // runtime port 的取消/失败收据不能恢复 ready；原 writer 结算后仍保留 binding fence。
        const operation =
          error && typeof error === "object" && "operation" in error ? error.operation : undefined;
        if (
          !operation ||
          typeof operation !== "object" ||
          !("status" in operation) ||
          !["cancelled", "running", "failed"].includes(String(operation.status))
        )
          throw error;
      }
      // 先发取消再等待原 writer 结算；独占 binding 锁后写投影，不能用旧快照覆盖已提交的新引用。
      return store.lock(binding.id, async () => {
        const latest = (await store.readBinding(binding.id)) ?? binding;
        if (latest.status === "ready" || latest.environmentUpgrade?.requestId !== params.requestId)
          return latest;
        const published = committed ? environmentReference(committed) : undefined;
        if (
          published &&
          (published.environmentId !== params.expectedEnvironmentRef.environmentId ||
            published.revision < params.expectedEnvironmentRef.revision)
        )
          throw new Error("Environment cancellation receipt differs from its journal");
        // 原 prepare 的成功回复可能丢失；cancel 返回成功收据时补齐新引用，再开放新请求。
        const settled = {
          ...latest,
          ...(published && !latest.environmentRebuild?.newEnvironmentRef
            ? {
                environmentRef: published,
                environmentRebuild: {
                  ...latest.environmentRebuild,
                  oldEnvironmentRef: params.expectedEnvironmentRef,
                  newEnvironmentRef: published,
                },
              }
            : {}),
          environmentUpgrade: {
            ...latest.environmentUpgrade,
            requestId: params.requestId,
            cancelled: true,
          },
          updatedAt: new Date().toISOString(),
        };
        await store.saveBinding(settled);
        return settled;
      });
    }
    return store.lock(params.bindingId, async () => {
      let value = await store.readBinding(params.bindingId);
      if (!value) throw new Error("Worktree binding not found");
      if (value.environmentUpgrade?.requestId === params.requestId && value.status === "ready") {
        if (
          !sameEnvironment(
            value.environmentRebuild?.oldEnvironmentRef,
            params.expectedEnvironmentRef,
          )
        )
          throw new Error("Environment upgrade request ID cannot change its expected reference");
        return value;
      }
      if (!["ready", "updating"].includes(value.status))
        throw new Error("Worktree is not ready for an environment upgrade");
      const previousRequestId =
        value.status === "updating" ? value.environmentUpgrade?.requestId : undefined;
      const replacing = value.status === "updating" && previousRequestId !== params.requestId;
      if (
        replacing &&
        (!previousRequestId ||
          value.environmentUpgrade?.cancelled !== true ||
          !(await store.isPreparationCancelled(cancellationKey(value.id, previousRequestId))))
      )
        throw new Error("Finish the existing environment upgrade before starting another");
      const oldReference =
        value.status === "updating" && !replacing
          ? value.environmentRebuild?.oldEnvironmentRef
          : value.environmentRef;
      if (!oldReference || !sameEnvironment(oldReference, params.expectedEnvironmentRef))
        throw new Error("Environment upgrade reference is stale");
      await ready(value);
      if (
        !context.prepareRuntimeEnvironment ||
        !context.resolveRuntimeEnvironment ||
        !context.releaseRuntimeEnvironment ||
        !context.rebindRuntimeEnvironmentSessions
      )
        throw new Error("Managed environment upgrade capability is unavailable");
      if (await store.isPreparationCancelled(cancelKey))
        throw new Error("Environment upgrade was cancelled");
      let lease;
      try {
        if (replacing && value.environmentRebuild?.newEnvironmentRef) {
          // 取消可能晚于 manifest 发布；先沿旧 journal 完成 session CAS，不能丢掉仍引用旧代的会话。
          const recoveryLease = await coordinator.acquire({
            workspacePath: value.checkoutPath,
            ownerId: `upgrade-reconcile:${value.id}:${previousRequestId}`,
            waitMs: 250,
          });
          try {
            value = await rebuildBindingRuntime(
              context,
              value,
              previousRequestId!,
              "upgrade",
              recoveryLease,
            );
          } finally {
            await coordinator.release(recoveryLease);
          }
        }
        if (value.status !== "updating" || replacing) {
          value = {
            ...value,
            status: "updating",
            error: undefined,
            environmentUpgrade: { requestId: params.requestId },
            environmentRebuild: {
              oldEnvironmentId: oldReference.environmentId,
              oldEnvironmentRef: oldReference,
              status: "pending",
            },
          };
          await store.saveBinding(value);
        }
        if (!value.environmentRebuild?.newEnvironmentRef) {
          await releaseBindingRuntime(context, value, params.requestId, "upgrade", "fence");
          await releaseBindingRuntime(context, value, params.requestId, "upgrade", "stop");
        }
        lease = await coordinator.acquire({
          workspacePath: value.checkoutPath,
          ownerId: `upgrade:${value.id}:${params.requestId}`,
          waitMs: 250,
        });
        await ready(value);
        value = await rebuildBindingRuntime(context, value, params.requestId, "upgrade", lease);
        return await store.lock(cancelKey, async () => {
          if (await store.isPreparationCancelled(cancelKey))
            throw new Error("Environment upgrade was cancelled");
          const completed: WorktreeBinding = {
            ...value!,
            status: "ready",
            error: undefined,
            updatedAt: new Date().toISOString(),
          };
          await store.saveBinding(completed);
          return completed;
        });
      } catch (error) {
        const latest = (await store.readBinding(params.bindingId)) ?? value;
        await store.saveBinding({
          ...latest,
          status: "updating",
          environmentRebuild: { ...latest.environmentRebuild, status: "failed" },
          error: error instanceof Error ? error.message : String(error),
          updatedAt: new Date().toISOString(),
        });
        throw error;
      } finally {
        if (lease) await coordinator.release(lease);
      }
    });
  };
}
