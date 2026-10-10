import type { RuntimeEnvironmentRecord } from "@lcode/shared";
import type { RuntimeEnvironmentReleaseRequest, RuntimeProcessOwnerObserver } from "../contract.js";
import { assertEnvironmentScope } from "./preparationAdmission.js";
import { releaseRuntimeEnvironment } from "./consumerLifecycle.js";
import { hasServiceExitProof } from "../domain/services.js";
import { settleConfirmedProcessExits } from "./consumerOwnerReceipts.js";
import { discardConsumerEligibility } from "./discardConsumerEligibility.js";
import type { RuntimeEnvironmentStore } from "./ports.js";

export function createWorktreeEnvironmentRelease(options: {
  store: RuntimeEnvironmentStore;
  stamp(): string;
  stopAll(
    record: RuntimeEnvironmentRecord,
  ): Promise<{ status: "stopped" | "blocked"; reason?: string }>;
  clearRebuildable(environmentId: string): Promise<void>;
  discardResources(environmentId: string): Promise<void>;
  observeProcessOwner?: RuntimeProcessOwnerObserver;
}) {
  return async (
    params: RuntimeEnvironmentReleaseRequest & {
      bindingId: string;
      intent: "discard" | "archive" | "candidate-cancel" | "upgrade";
      phase: "fence" | "stop" | "cleanup" | "finalize";
      legacyDiscardSessionIds?: string[];
    },
  ): Promise<{ status: "completed" | "releaseBlocked"; reason?: string }> => {
    const { store, stamp } = options;
    const read = () =>
      store.lock(params.environmentId, async () => {
        const record = await store.readEnvironment(params.environmentId);
        if (!record) throw new Error("stale-reference: runtime environment is missing");
        assertEnvironmentScope(record, params);
        if (
          record.bindingId !== params.bindingId ||
          (params.expectedRevision !== undefined &&
            params.expectedRevision !== record.currentRevision) ||
          (params.expectedManifestDigest !== undefined &&
            params.expectedManifestDigest !== record.manifestDigest)
        )
          throw new Error("stale-reference: worktree environment changed");
        return record;
      });
    let record = await read();
    // 旧版 released 仅代表逻辑引用结算；明确删除不能因此跳过仍占空间的私有目录。
    const discardCleanup = params.intent === "discard" && params.phase === "cleanup";
    if (record.status === "released" && !discardCleanup) return { status: "completed" };
    if (discardCleanup && record.activeOperationId)
      return { status: "releaseBlocked", reason: "release-blocked: preparation has not settled" };
    if (params.phase === "fence") {
      return store.lock(params.environmentId, async () => {
        record = (await store.readEnvironment(params.environmentId))!;
        assertEnvironmentScope(record, params);
        if (
          record.bindingId !== params.bindingId ||
          (params.expectedRevision !== undefined &&
            params.expectedRevision !== record.currentRevision) ||
          (params.expectedManifestDigest !== undefined &&
            params.expectedManifestDigest !== record.manifestDigest)
        )
          throw new Error("stale-reference: lifecycle changed before its fence");
        if (
          record.activeOperationId ||
          ["resolvingTools", "installingTools", "preparingDependencies", "cancelling"].includes(
            record.status,
          )
        )
          return {
            status: "releaseBlocked",
            reason: "release-blocked: preparation has not settled",
          };
        if (
          record.fenceIntent &&
          record.fenceIntent !== params.intent &&
          !(params.intent === "discard" && ["archive", "upgrade"].includes(record.fenceIntent))
        )
          return {
            status: "releaseBlocked",
            reason: "release-blocked: another lifecycle operation owns the fence",
          };
        await store.saveEnvironment({
          ...record,
          status: params.intent === "upgrade" ? "needsUpdate" : "releasing",
          fenceIntent: params.intent,
          updatedAt: stamp(),
          error: undefined,
        });
        return { status: "completed" };
      });
    }
    if (record.fenceIntent !== params.intent && !(record.status === "released" && discardCleanup))
      return { status: "releaseBlocked", reason: "release-blocked: lifecycle fence is missing" };
    if (params.phase === "stop") {
      const result = await options.stopAll(record);
      if (result.status !== "stopped") return { status: "releaseBlocked", reason: result.reason };
    }
    const busy = await store.lock(params.environmentId, async () => {
      const owners = await store.listConsumerOwnerReceipts(params.environmentId);
      const sessions = new Set(
        params.intent === "discard" && params.phase === "stop"
          ? (params.legacyDiscardSessionIds ?? [])
          : [],
      );
      for (const ref of await settleConfirmedProcessExits(store, params.environmentId, stamp)) {
        if (ref.state !== "active") continue;
        if (ref.kind === "session") {
          // stop 可保留待永久清理的聊天引用；data 删除必须等精确会话清理回调真正结算。
          if (discardCleanup) return true;
          continue;
        }
        if (
          !(await discardConsumerEligibility(
            ref,
            record.currentRevision,
            sessions,
            owners,
            options.observeProcessOwner,
          ))
        )
          return true;
      }
      for (const id of await store.listServiceIds(params.environmentId)) {
        const receipt = await store.readServiceReceipt(params.environmentId, id);
        if (!receipt || !hasServiceExitProof(receipt)) return true;
      }
      return false;
    });
    if (busy)
      return {
        status: "releaseBlocked",
        reason: "release-blocked: execution owner has not confirmed exit",
      };
    if (params.phase === "cleanup") {
      if (discardCleanup) await options.discardResources(params.environmentId);
      else await options.clearRebuildable(params.environmentId);
    }
    if (params.phase === "finalize" && params.intent !== "archive" && params.intent !== "upgrade") {
      const result = await releaseRuntimeEnvironment(
        store,
        {
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
          requestId: params.requestId,
          environmentId: params.environmentId,
          expectedRevision: params.expectedRevision,
          expectedManifestDigest: params.expectedManifestDigest,
        },
        stamp,
      );
      return result.status === "released"
        ? { status: "completed" }
        : { status: "releaseBlocked", reason: result.reason };
    }
    return { status: "completed" };
  };
}
