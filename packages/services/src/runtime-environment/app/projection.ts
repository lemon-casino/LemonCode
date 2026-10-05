import type { RuntimeEnvironmentProjection, RuntimeEnvironmentRecord } from "@lcode/shared";
import type { RuntimeEnvironmentStore } from "./ports.js";

/** UI 只读投影（spec §9.2）；manifest 缺失时工具列表为空。token/lease 不进投影。 */
export async function projectEnvironment(
  store: RuntimeEnvironmentStore,
  record: RuntimeEnvironmentRecord,
): Promise<RuntimeEnvironmentProjection> {
  const manifest = await store.readManifest(record.environmentId, record.currentRevision);
  return {
    environmentId: record.environmentId,
    purpose: record.purpose,
    status: record.status,
    currentRevision: record.currentRevision,
    tools: manifest?.tools ?? [],
    ...(manifest ? { manifestDigest: manifest.declarationDigest } : {}),
    ...(manifest ? { installStrategy: manifest.installStrategy } : {}),
    ...(record.error ? { error: record.error } : {}),
    updatedAt: record.updatedAt,
  };
}
