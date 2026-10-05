import type {
  ManagedServiceReceipt,
  RuntimeEnvironmentProjection,
  RuntimeEnvironmentRecord,
} from "@lcode/shared";
import type { RuntimeEnvironmentStore } from "./ports.js";

/** UI 只读投影（spec §9.2）；manifest 缺失时工具列表为空。token/lease 不进投影。 */
export async function projectEnvironment(
  store: RuntimeEnvironmentStore,
  record: RuntimeEnvironmentRecord,
): Promise<RuntimeEnvironmentProjection> {
  const manifest = await store.readManifest(record.environmentId, record.currentRevision);
  const services = await listServiceProjections(store, record.environmentId);
  return {
    environmentId: record.environmentId,
    purpose: record.purpose,
    status: record.status,
    currentRevision: record.currentRevision,
    tools: manifest?.tools ?? [],
    ...(manifest ? { manifestDigest: manifest.declarationDigest } : {}),
    ...(manifest ? { installStrategy: manifest.installStrategy } : {}),
    ...(services.length ? { services } : {}),
    ...(record.error ? { error: record.error } : {}),
    updatedAt: record.updatedAt,
  };
}

/** 服务地址事实（spec §12.3，M3 P3-06）：只读 state+urls，PID/诊断字段不出 Host。 */
async function listServiceProjections(
  store: RuntimeEnvironmentStore,
  environmentId: string,
): Promise<{ serviceId: string; state: ManagedServiceReceipt["state"]; urls: string[] }[]> {
  const knownIds = await store.listServiceIds(environmentId);
  const result: {
    serviceId: string;
    state: ManagedServiceReceipt["state"];
    urls: string[];
  }[] = [];
  for (const serviceId of knownIds) {
    const receipt = await store.readServiceReceipt(environmentId, serviceId);
    if (!receipt) continue;
    result.push({ serviceId: receipt.serviceId, state: receipt.state, urls: receipt.urls });
  }
  return result;
}
