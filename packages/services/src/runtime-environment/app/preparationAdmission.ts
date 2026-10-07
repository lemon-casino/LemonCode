import { resolve } from "node:path";
import type {
  RuntimeEnvironmentRecord,
  RuntimeEnvironmentScope,
  RuntimePreparationOperation,
} from "@lcode/shared";
import type { RuntimeEnvironmentPrepareRequest } from "../contract.js";
import { environmentIdFor, identityKeyOf, operationIdFor, scopeKeyHash } from "./ports.js";
import { finishPreparationCommit } from "./preparationCommit.js";
import {
  preparationError,
  type PreparationOptions,
  type PreparationRun,
} from "./preparationTypes.js";

export function assertEnvironmentScope(
  record: RuntimeEnvironmentRecord,
  scope: RuntimeEnvironmentScope,
): void {
  const canonical = (path: string) =>
    process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
  if (
    identityKeyOf(record.scope) !== identityKeyOf(scope) ||
    canonical(record.scope.workspacePath) !== canonical(scope.workspacePath)
  )
    throw new Error("scope-mismatch: runtime environment belongs to another workspace");
}
function fingerprint(params: RuntimeEnvironmentPrepareRequest): string {
  return scopeKeyHash([
    identityKeyOf(params),
    resolve(params.workspacePath),
    params.bindingId ?? null,
    params.purpose,
    params.operation ?? "prepare",
    params.environmentId ?? environmentIdFor(params, params.bindingId, params.purpose),
    params.expectedRevision ?? null,
    params.expectedManifestDigest ?? null,
  ]);
}
function newOperation(
  params: RuntimeEnvironmentPrepareRequest,
  envId: string,
  stamp: string,
): RuntimePreparationOperation {
  return {
    operationId: operationIdFor(params, params.requestId),
    requestId: params.requestId,
    environmentId: envId,
    requestFingerprint: fingerprint(params),
    status: "running",
    stage: "resolvingTools",
    cancelRequested: false,
    createdAt: stamp,
    updatedAt: stamp,
  };
}
export async function admitPreparation(
  options: PreparationOptions,
  params: RuntimeEnvironmentPrepareRequest,
): Promise<{
  operation: RuntimePreparationOperation;
  run?: PreparationRun;
}> {
  const { store, stamp } = options;
  const opId = operationIdFor(params, params.requestId);
  const proposedId =
    params.operation === "restore"
      ? scopeKeyHash([
          "restore",
          identityKeyOf(params),
          params.bindingId ?? null,
          params.purpose,
          params.requestId,
        ])
      : (params.environmentId ?? environmentIdFor(params, params.bindingId, params.purpose));
  return store.lock(scopeKeyHash(["request", opId]), async () => {
    const found = await store.readOperation(opId);
    if (
      found &&
      (found.requestFingerprint
        ? found.requestFingerprint !== fingerprint(params)
        : found.environmentId !== proposedId)
    )
      throw new Error("scope-mismatch: requestId already belongs to a different preparation");
    const envId = found?.environmentId ?? proposedId;
    return store.lock(envId, async () => {
      const existing = await store.readOperation(opId);
      const record = await store.readEnvironment(envId);
      if (record) {
        assertEnvironmentScope(record, params);
        if (record.bindingId !== params.bindingId || record.purpose !== params.purpose)
          throw new Error("scope-mismatch: preparation binding or purpose differs");
      }
      if (existing?.status === "running" && existing.commitManifest && record)
        return { operation: await finishPreparationCommit(store, existing, record, stamp) };
      if (params.cancel) {
        if (existing && existing.status !== "running") return { operation: existing };
        const operation: RuntimePreparationOperation = {
          ...(existing ?? newOperation(params, envId, stamp())),
          cancelRequested: true,
          status: existing ? "running" : "cancelled",
          stage: existing ? "cancelling" : "cancelled",
          updatedAt: stamp(),
        };
        await store.saveOperation(operation);
        if (record && record.activeOperationId === opId)
          await store.saveEnvironment({ ...record, status: "cancelling", updatedAt: stamp() });
        return { operation };
      }
      if (existing?.status === "succeeded" || existing?.status === "cancelled")
        return { operation: existing };
      const base = existing ?? newOperation(params, envId, stamp());
      const rejected = async (code: Parameters<typeof preparationError>[0], message: string) => {
        const operation: RuntimePreparationOperation = {
          ...base,
          status: "failed",
          error: preparationError(code, "resolvingTools", message),
          updatedAt: stamp(),
        };
        await store.saveOperation(operation);
        return { operation };
      };
      if (record && ["releasing", "releaseBlocked", "released"].includes(record.status))
        return rejected(
          "release-blocked",
          "environment is fenced; restore requires a new environment",
        );
      if (params.operation === "restore" && params.environmentId) {
        const previous = await store.readEnvironment(params.environmentId);
        if (!previous)
          return rejected("stale-reference", "previous environment is missing during restore");
        assertEnvironmentScope(previous, params);
        if (
          previous.bindingId !== params.bindingId ||
          previous.purpose !== params.purpose ||
          (params.expectedRevision !== undefined &&
            params.expectedRevision !== previous.currentRevision) ||
          (params.expectedManifestDigest !== undefined &&
            params.expectedManifestDigest !== previous.manifestDigest)
        )
          return rejected("stale-reference", "previous environment changed before restore");
      }
      if (
        params.operation !== "restore" &&
        params.expectedRevision !== undefined &&
        params.expectedRevision !== (record?.currentRevision ?? 0)
      )
        return rejected("stale-reference", "environment revision changed before preparation");
      if (
        params.operation !== "restore" &&
        params.expectedManifestDigest !== undefined &&
        params.expectedManifestDigest !== record?.manifestDigest
      )
        return rejected("stale-reference", "environment manifest changed before preparation");
      const release = await store.claimPreparation(envId);
      if (!release) {
        if (existing?.status === "running") return { operation: existing };
        return rejected("resource-busy", "another preparation owner is still running");
      }
      try {
        if (existing?.status === "running") {
          // 执行租约已无人持有才判崩溃；查询只结算未知结果，不偷偷重放有副作用的安装。
          const operation: RuntimePreparationOperation = {
            ...existing,
            status: existing.cancelRequested ? "cancelled" : "failed",
            stage: existing.cancelRequested ? "cancelled" : existing.stage,
            error: existing.cancelRequested
              ? undefined
              : preparationError(
                  "process-unknown",
                  "resolvingTools",
                  "preparation owner exited; explicit retry is required",
                ),
            updatedAt: stamp(),
          };
          await store.saveOperation(operation);
          if (record?.activeOperationId === opId)
            await store.saveEnvironment({
              ...record,
              activeOperationId: undefined,
              status: operation.status === "cancelled" ? "cancelled" : "failed",
              error: operation.error,
              updatedAt: stamp(),
            });
          await release();
          return { operation };
        }
        if (record?.activeOperationId && record.activeOperationId !== opId) {
          const active = await store.readOperation(record.activeOperationId);
          if (active?.status === "running") {
            await release();
            return rejected(
              "process-unknown",
              "previous preparation must be reconciled before starting another request",
            );
          }
        }
        const operation: RuntimePreparationOperation = {
          ...base,
          status: "running",
          stage: "resolvingTools",
          cancelRequested: false,
          error: undefined,
          targetRevision: (record?.currentRevision ?? 0) + 1,
          updatedAt: stamp(),
        };
        const next: RuntimeEnvironmentRecord = {
          ...(record ?? {
            environmentId: envId,
            scope: {
              workspacePath: params.workspacePath,
              ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
            },
            bindingId: params.bindingId,
            purpose: params.purpose,
            currentRevision: 0,
            createdAt: stamp(),
          }),
          activeOperationId: opId,
          status: "resolvingTools",
          error: undefined,
          updatedAt: stamp(),
        };
        await store.saveOperation(operation);
        await store.saveEnvironment(next);
        return { operation, run: { params, operation, record: next, release } };
      } catch (error) {
        await release();
        throw error;
      }
    });
  });
}
