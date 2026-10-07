import type {
  ManagedServiceReceipt,
  RuntimeEnvironmentProjection,
  RuntimeEnvironmentRecord,
} from "@lcode/shared";
import type { RuntimeEnvironmentStore } from "./ports.js";

export async function projectEnvironment(
  store: RuntimeEnvironmentStore,
  record: RuntimeEnvironmentRecord,
  reconcileReceipt?: (
    record: RuntimeEnvironmentRecord,
    receipt: ManagedServiceReceipt,
  ) => Promise<ManagedServiceReceipt>,
): Promise<RuntimeEnvironmentProjection> {
  const manifest = await store.readManifest(record.environmentId, record.currentRevision);
  const sources = new Set(manifest?.tools.map((tool) => tool.source));
  const services: NonNullable<RuntimeEnvironmentProjection["services"]> = [];
  for (const id of await store.listServiceIds(record.environmentId)) {
    const stored = await store.readServiceReceipt(record.environmentId, id);
    const receipt = stored && reconcileReceipt ? await reconcileReceipt(record, stored) : stored;
    if (receipt)
      services.push({
        serviceId: id,
        state: receipt.state,
        generation: receipt.generation,
        stateRevision: receipt.stateRevision,
        operationId: receipt.operationId,
        urls: receipt.state === "running" && receipt.healthCheckedAt ? receipt.urls : [],
      });
  }
  const operationId = record.activeOperationId ?? record.lastOperationId;
  const operation = operationId ? await store.readOperation(operationId) : null;
  return {
    environmentId: record.environmentId,
    purpose: record.purpose,
    status: record.status,
    currentRevision: record.currentRevision,
    stateRevision: record.stateRevision ?? 0,
    tools: manifest?.tools ?? [],
    ...(manifest
      ? {
          manifestDigest: manifest.manifestDigest ?? manifest.declarationDigest,
          declarationDigest: manifest.declarationDigest,
          installStrategy: manifest.installStrategy,
          toolSource: sources.size === 1 ? manifest.tools[0]?.source : ("partial-host" as const),
        }
      : {}),
    ...(record.resourceSummary ? { resourceSummary: record.resourceSummary } : {}),
    ...(services.length ? { services } : {}),
    ...(record.error ? { error: record.error } : {}),
    ...(operation
      ? {
          operation: {
            operationId: operation.operationId,
            kind: "prepare" as const,
            status: operation.status === "cancelled" ? ("failed" as const) : operation.status,
            updatedAt: operation.updatedAt,
            stateRevision: record.stateRevision,
            error: operation.error,
          },
        }
      : {}),
    updatedAt: record.updatedAt,
  };
}
