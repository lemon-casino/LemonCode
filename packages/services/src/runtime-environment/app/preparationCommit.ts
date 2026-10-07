import type { RuntimeEnvironmentRecord, RuntimePreparationOperation } from "@lcode/shared";
import type { RuntimeEnvironmentStore } from "./ports.js";

/** 在环境短锁内完成已接受的 ready 意图；不重放工具安装、依赖脚本或用户输入。 */
export async function finishPreparationCommit(
  store: RuntimeEnvironmentStore,
  operation: RuntimePreparationOperation,
  record: RuntimeEnvironmentRecord,
  stamp: () => string,
): Promise<RuntimePreparationOperation> {
  const manifest = operation.commitManifest;
  const target = operation.targetRevision;
  if (!manifest || !target || !manifest.manifestDigest)
    throw new Error("stale-reference: preparation commit intent is incomplete");
  if (
    operation.environmentId !== record.environmentId ||
    record.currentRevision > target ||
    (record.activeOperationId !== operation.operationId &&
      !(record.lastOperationId === operation.operationId && record.currentRevision === target))
  )
    throw new Error("stale-reference: another operation owns the environment commit");
  await store.saveManifest(record.environmentId, target, manifest);
  if (
    record.currentRevision !== target ||
    record.manifestDigest !== manifest.manifestDigest ||
    record.activeOperationId === operation.operationId
  ) {
    await store.saveEnvironment({
      ...record,
      activeOperationId: undefined,
      lastOperationId: operation.operationId,
      currentRevision: target,
      manifestDigest: manifest.manifestDigest,
      status: "ready",
      fenceIntent: undefined,
      error: undefined,
      updatedAt: stamp(),
    });
  }
  const done: RuntimePreparationOperation = {
    ...operation,
    status: "succeeded",
    stage: "ready",
    error: undefined,
    updatedAt: stamp(),
  };
  await store.saveOperation(done);
  return done;
}
