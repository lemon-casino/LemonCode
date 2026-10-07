import type {
  FrozenManifest,
  RuntimeEnvironmentError,
  RuntimeEnvironmentRecord,
  RuntimePreparationOperation,
} from "@lcode/shared";
import type { PreparationOptions, PreparationRun } from "./preparationTypes.js";
import { preparationError } from "./preparationTypes.js";
import { finishPreparationCommit } from "./preparationCommit.js";

export class PreparationCancelled extends Error {
  constructor() {
    super("preparation cancellation requested");
  }
}
export async function preparationCheckpoint(
  options: PreparationOptions,
  run: PreparationRun,
  stage?: RuntimePreparationOperation["stage"],
  plan?: FrozenManifest,
): Promise<void> {
  await options.store.lock(run.record.environmentId, async () => {
    const current = await options.store.readOperation(run.operation.operationId);
    const record = await options.store.readEnvironment(run.record.environmentId);
    if (!current || current.status !== "running" || current.cancelRequested)
      throw new PreparationCancelled();
    if (
      !record ||
      record.activeOperationId !== current.operationId ||
      ["releasing", "releaseBlocked", "released"].includes(record.status)
    )
      throw Object.assign(new Error("environment fence changed during preparation"), {
        code: "stale-reference",
      });
    if (stage || plan) {
      const next = {
        ...current,
        ...(stage ? { stage } : {}),
        ...(plan ? { plan } : {}),
        updatedAt: options.stamp(),
      };
      await options.store.saveOperation(next);
      if (stage)
        await options.store.saveEnvironment({
          ...record,
          status: stage,
          updatedAt: options.stamp(),
        });
      run.operation = next;
    }
  });
}
export async function settlePreparation(
  options: PreparationOptions,
  run: PreparationRun,
  result: {
    manifest?: FrozenManifest;
    reuseRevision?: number;
    error?: RuntimeEnvironmentError;
    failureStatus?: RuntimeEnvironmentRecord["status"];
  },
): Promise<RuntimePreparationOperation> {
  return options.store.lock(run.record.environmentId, async () => {
    const current = await options.store.readOperation(run.operation.operationId);
    const record = await options.store.readEnvironment(run.record.environmentId);
    if (!current) throw new Error("preparation operation is missing");
    if (current.status !== "running") return current;
    if (current.commitManifest && record)
      return finishPreparationCommit(options.store, current, record, options.stamp);
    if (!record || record.activeOperationId !== current.operationId)
      throw new Error("stale-reference: preparation no longer owns the environment");
    const cancelled = current.cancelRequested;
    const error = cancelled
      ? preparationError("cancelled", "cancelling", "preparation cancelled after execution settled")
      : result.error;
    if (!cancelled && !error) {
      const manifest =
        result.manifest ??
        (await options.store.readManifest(
          record.environmentId,
          result.reuseRevision ?? record.currentRevision,
        ));
      if (!manifest) throw new Error("stale-reference: ready has no frozen manifest");
      const intent: RuntimePreparationOperation = {
        ...current,
        commitManifest: manifest,
        targetRevision:
          result.reuseRevision ?? current.targetRevision ?? record.currentRevision + 1,
        updatedAt: options.stamp(),
      };
      await options.store.saveOperation(intent);
      return finishPreparationCommit(options.store, intent, record, options.stamp);
    }
    const done: RuntimePreparationOperation = {
      ...current,
      status: cancelled ? "cancelled" : "failed",
      stage: cancelled ? "cancelled" : current.stage,
      error,
      updatedAt: options.stamp(),
    };
    await options.store.saveEnvironment({
      ...record,
      activeOperationId: undefined,
      lastOperationId: current.operationId,
      status: cancelled ? "cancelled" : (result.failureStatus ?? "failed"),
      error,
      updatedAt: options.stamp(),
    });
    await options.store.saveOperation(done);
    return done;
  });
}
