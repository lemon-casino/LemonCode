import { readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { atomicWritePrivateTextFile, withFileLock } from "@lcode/shared/node";
import {
  dependencyReceiptSchema,
  frozenManifestSchema,
  managedServiceReceiptSchema,
  runtimeConsumerReferenceSchema,
  runtimeEnvironmentRecordSchema,
  runtimePreparationOperationSchema,
  type DependencyReceipt,
  type RuntimeEnvironmentRecord,
} from "@lcode/shared";
import { scopeKeyHash, type RuntimeEnvironmentStore } from "../app/ports.js";

/**
 * 环境持久化实现（spec: specs/worktree-runtime-environments.md §8.2/§8.3）。
 * records/operations/manifests/receipts/services 全部在 HostDataRoot 的
 * runtime-environments/ 下。严格校验：损坏/未知版本记录明确失败不修成 ready；
 * 短记录锁，不覆盖长安装。port 类型在 app/ports.ts（层向：adapters→app 允许）。
 */

export type { RuntimeEnvironmentStore };

function manifestRecordId(environmentId: string, revision: number): string {
  return scopeKeyHash(["manifest", environmentId, revision]);
}

function receiptRecordId(environmentId: string): string {
  // 每环境一份最新依赖收据（重装覆盖写）；按 id 校验读写。
  return scopeKeyHash(["receipt", environmentId]);
}

function serviceRecordId(environmentId: string, serviceId: string): string {
  // 每环境每服务一份最新收据（spec §12.1）；serviceId 是调用方受控字符串，进哈希前不落盘。
  return scopeKeyHash(["service", environmentId, serviceId]);
}

function serviceIndexRecordId(environmentId: string): string {
  // 每环境服务 ID 索引（serviceId 哈希后不可反查，投影遍历靠它）。
  return scopeKeyHash(["service-index", environmentId]);
}

const consumerListSchema = z
  .object({
    schemaVersion: z.literal(1),
    consumers: z.array(runtimeConsumerReferenceSchema).max(4096),
  })
  .strict();

function consumerRecordId(environmentId: string): string {
  if (!/^[a-f0-9]{32}$/.test(environmentId)) throw new Error("Invalid consumer environment id");
  return scopeKeyHash(["consumers", environmentId]);
}

function parseConsumers(value: unknown, environmentId: string) {
  const record = consumerListSchema.parse(value);
  const keys = new Set<string>();
  for (const reference of record.consumers) {
    const key = JSON.stringify([reference.kind, reference.id]);
    if (reference.environmentId !== environmentId || keys.has(key))
      throw new Error("Consumer record scope mismatch or duplicate identity");
    keys.add(key);
  }
  return record;
}

export function createRuntimeEnvironmentStore(dataDir: string): RuntimeEnvironmentStore {
  const root = resolve(dataDir);
  const recordPath = (kind: string, id: string) => {
    if (!/^[a-f0-9]{32}$/.test(id)) throw new Error("Invalid runtime environment record id");
    return join(root, kind, `${id}.json`);
  };

  async function readRecord<T>(
    kind: string,
    id: string,
    parse: (value: unknown) => T,
  ): Promise<T | null> {
    let raw: string;
    try {
      raw = await readFile(recordPath(kind, id), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try {
      return parse(JSON.parse(raw));
    } catch (error) {
      // 根因：损坏或未知 schemaVersion 的记录不能被静默修成 ready（spec §8.3）。
      throw new Error(
        `Runtime environment record ${kind}/${id} is corrupt or has an unknown schema version`,
        { cause: error },
      );
    }
  }

  return {
    lock: (key, action) =>
      withFileLock(recordPath("locks", key), action, { lockMaxWaitMs: 30_000 }),
    readEnvironment: (id) =>
      readRecord("records", id, (value) => {
        const record = runtimeEnvironmentRecordSchema.parse(value);
        if (record.environmentId !== id) throw new Error("Record ID does not match its filename");
        return record;
      }),
    saveEnvironment: async (record) => {
      await atomicWritePrivateTextFile(
        recordPath("records", record.environmentId),
        `${JSON.stringify(runtimeEnvironmentRecordSchema.parse(record), null, 2)}\n`,
      );
    },
    listEnvironments: async () => {
      let files: string[];
      try {
        files = await readdir(join(root, "records"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      const values: RuntimeEnvironmentRecord[] = [];
      for (const file of files.filter((name) => /^[a-f0-9]{32}\.json$/.test(name))) {
        const id = file.slice(0, -5);
        const record = await readRecord("records", id, (value) =>
          runtimeEnvironmentRecordSchema.parse(value),
        );
        if (record) values.push(record);
      }
      return values;
    },
    readOperation: (id) =>
      readRecord("operations", id, (value) => {
        const operation = runtimePreparationOperationSchema.parse(value);
        if (operation.operationId !== id) throw new Error("Operation ID does not match filename");
        return operation;
      }),
    saveOperation: async (operation) => {
      await atomicWritePrivateTextFile(
        recordPath("operations", operation.operationId),
        `${JSON.stringify(runtimePreparationOperationSchema.parse(operation), null, 2)}\n`,
      );
    },
    readManifest: (environmentId, revision) =>
      readRecord("manifests", manifestRecordId(environmentId, revision), (value) =>
        frozenManifestSchema.parse(value),
      ),
    saveManifest: async (environmentId, revision, manifest) => {
      await atomicWritePrivateTextFile(
        recordPath("manifests", manifestRecordId(environmentId, revision)),
        `${JSON.stringify(frozenManifestSchema.parse(manifest), null, 2)}\n`,
      );
    },
    removeEnvironment: async (id) => {
      recordPath("records", id);
      await rm(recordPath("records", id), { force: true });
    },
    readDependencyReceipt: (environmentId) =>
      readRecord("receipts", receiptRecordId(environmentId), (value) =>
        dependencyReceiptSchema.parse(value),
      ),
    saveDependencyReceipt: async (receipt: DependencyReceipt) => {
      await atomicWritePrivateTextFile(
        recordPath("receipts", receiptRecordId(receipt.environmentId)),
        `${JSON.stringify(dependencyReceiptSchema.parse(receipt), null, 2)}\n`,
      );
    },
    readServiceReceipt: (environmentId, serviceId) =>
      readRecord("services", serviceRecordId(environmentId, serviceId), (value) =>
        managedServiceReceiptSchema.parse(value),
      ),
    saveServiceReceipt: async (receipt) => {
      // 每环境服务索引：serviceId 是调用方受控字符串，哈希后不可反查，落索引记录供投影遍历。
      const indexId = serviceIndexRecordId(receipt.environmentId);
      const existing = await readRecord("services", indexId, (value) =>
        z.object({ serviceIds: z.array(z.string().min(1)) }).parse(value),
      );
      const serviceIds = existing?.serviceIds ?? [];
      if (!serviceIds.includes(receipt.serviceId)) serviceIds.push(receipt.serviceId);
      await atomicWritePrivateTextFile(
        recordPath("services", indexId),
        `${JSON.stringify({ serviceIds }, null, 2)}\n`,
      );
      await atomicWritePrivateTextFile(
        recordPath("services", serviceRecordId(receipt.environmentId, receipt.serviceId)),
        `${JSON.stringify(managedServiceReceiptSchema.parse(receipt), null, 2)}\n`,
      );
    },
    listServiceIds: async (environmentId) => {
      const index = await readRecord("services", serviceIndexRecordId(environmentId), (value) =>
        z.object({ serviceIds: z.array(z.string().min(1)) }).parse(value),
      );
      return index?.serviceIds ?? [];
    },
    listConsumers: async (environmentId) => {
      const value = await readRecord("consumers", consumerRecordId(environmentId), (value) =>
        parseConsumers(value, environmentId),
      );
      return value?.consumers ?? [];
    },
    saveConsumers: async (environmentId, consumers) => {
      const value = parseConsumers({ schemaVersion: 1, consumers }, environmentId);
      await atomicWritePrivateTextFile(
        recordPath("consumers", consumerRecordId(environmentId)),
        `${JSON.stringify(value)}\n`,
      );
    },
  };
}

/** HostDataRoot 下环境资源目录布局（spec §8.3）；组合根注入用。 */
export function runtimeEnvironmentDataDirs(dataDir: string): {
  root: string;
  toolBackends: string;
  toolStore: string;
  packageStore: string;
} {
  const base = resolve(dataDir);
  return {
    root: base,
    toolBackends: join(base, "tool-backends"),
    toolStore: join(base, "tool-store"),
    packageStore: join(base, "package-store"),
  };
}

/**
 * 单环境的资源目录映射（spec §8.3，M3 P3-05）：temp/cache/data/logs 按环境 ID 隔离，
 * 永不进 checkout、不共享可写产物。environmentId 必须是受管 32 hex；防路径穿越，
 * 拒绝把资源目录指到受管根之外。
 */
export function environmentResourceDirs(
  dataDir: string,
  environmentId: string,
): {
  environmentRoot: string;
  temp: string;
  cache: string;
  data: string;
  logs: string;
} {
  if (!/^[a-f0-9]{32}$/.test(environmentId))
    throw new Error("Invalid runtime environment id for resource dirs");
  const base = resolve(runtimeEnvironmentDataDirs(dataDir).root, "resources", environmentId);
  return {
    environmentRoot: base,
    temp: join(base, "temp"),
    cache: join(base, "cache"),
    data: join(base, "data"),
    logs: join(base, "logs"),
  };
}
