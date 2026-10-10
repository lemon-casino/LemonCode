import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { acquireFileLock, atomicWritePrivateTextFile, withFileLock } from "@lcode/shared/node";
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

const ownerReceiptSchema = runtimeConsumerReferenceSchema
  .pick({
    environmentId: true,
    revision: true,
    id: true,
    ownerId: true,
    ownerGeneration: true,
    lease: true,
  })
  .extend({
    kind: z.literal("process"),
    processOwner: z
      .object({
        runtimeInstanceId: z.string().min(1).max(512),
        runtimeGeneration: z.number().int().positive(),
        workspacePath: z.string().min(1).max(4096),
        workspaceIdentity: z.string().min(1).max(4096).optional(),
        startedAt: z.number().int().nonnegative(),
        pid: z.number().int().positive().optional(),
      })
      .strict(),
    exitConfirmedAt: z.iso.datetime().optional(),
  })
  .strict();
const ownerListSchema = z
  .object({ schemaVersion: z.literal(1), receipts: z.array(ownerReceiptSchema).max(4096) })
  .strict();
const retirementListSchema = z
  .object({
    schemaVersion: z.literal(1),
    receipts: z
      .array(
        ownerReceiptSchema
          .omit({ processOwner: true, exitConfirmedAt: true })
          .extend({
            bindingId: z.string().min(1).max(4096),
            requestId: z.string().min(1).max(512),
            reason: z.literal("confirmed-worktree-discard"),
            retiredAt: z.iso.datetime(),
            orphanedOwner: z
              .object({
                processOwner: ownerReceiptSchema.shape.processOwner,
                observedAt: z.iso.datetime(),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .max(4096),
  })
  .strict();
function parseRetirements(value: unknown, environmentId: string) {
  const record = retirementListSchema.parse(value);
  const ids = new Set<string>();
  for (const receipt of record.receipts) {
    if (receipt.environmentId !== environmentId || ids.has(receipt.id))
      throw new Error("Consumer retirement scope mismatch or duplicate consumer");
    ids.add(receipt.id);
  }
  return record;
}
function parseOwnerReceipts(value: unknown, environmentId: string) {
  const record = ownerListSchema.parse(value);
  const ids = new Set<string>();
  for (const receipt of record.receipts) {
    if (receipt.environmentId !== environmentId || ids.has(receipt.id))
      throw new Error("Process owner receipt scope mismatch or duplicate consumer");
    ids.add(receipt.id);
  }
  return record;
}

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

export function createRuntimeEnvironmentStore(
  dataDir: string,
  onChanged?: (record: RuntimeEnvironmentRecord) => void,
): RuntimeEnvironmentStore {
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
    claimPreparation: async (id) => {
      const path = recordPath("executions", id);
      await mkdir(join(root, "executions"), { recursive: true });
      try {
        return await acquireFileLock(path, [10, 20], 100, 150);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "LCODE_FILE_LOCK_TIMEOUT") return null;
        throw error;
      }
    },
    readEnvironment: (id) =>
      readRecord("records", id, (value) => {
        const record = runtimeEnvironmentRecordSchema.parse(value);
        if (record.environmentId !== id) throw new Error("Record ID does not match its filename");
        return record;
      }),
    saveEnvironment: async (record) => {
      const previous = await readRecord("records", record.environmentId, (value) =>
        runtimeEnvironmentRecordSchema.parse(value),
      );
      // 所有写者持同一环境短锁；事实版本取落盘记录而不是调用方缓存，防旧帧覆盖新事实。
      const next = runtimeEnvironmentRecordSchema.parse({
        ...record,
        stateRevision: (previous?.stateRevision ?? 0) + 1,
      });
      await atomicWritePrivateTextFile(
        recordPath("records", record.environmentId),
        `${JSON.stringify(next, null, 2)}\n`,
      );
      onChanged?.(next);
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
      const id = manifestRecordId(environmentId, revision);
      const next = frozenManifestSchema.parse(manifest);
      const previous = await readRecord("manifests", id, (value) =>
        frozenManifestSchema.parse(value),
      );
      if (previous && JSON.stringify(previous) !== JSON.stringify(next))
        throw new Error("stale-reference: a published manifest is immutable");
      if (!previous)
        await atomicWritePrivateTextFile(
          recordPath("manifests", id),
          `${JSON.stringify(next, null, 2)}\n`,
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
    listConsumerOwnerReceipts: async (environmentId) => {
      const value = await readRecord("consumer-owners", consumerRecordId(environmentId), (value) =>
        parseOwnerReceipts(value, environmentId),
      );
      return value?.receipts ?? [];
    },
    saveConsumerOwnerReceipts: async (environmentId, receipts) => {
      const value = parseOwnerReceipts({ schemaVersion: 1, receipts }, environmentId);
      await atomicWritePrivateTextFile(
        recordPath("consumer-owners", consumerRecordId(environmentId)),
        `${JSON.stringify(value)}\n`,
      );
    },
    listConsumerRetirements: async (environmentId) => {
      const value = await readRecord(
        "consumer-retirements",
        consumerRecordId(environmentId),
        (value) => parseRetirements(value, environmentId),
      );
      return value?.receipts ?? [];
    },
    saveConsumerRetirements: async (environmentId, receipts) => {
      const value = parseRetirements({ schemaVersion: 1, receipts }, environmentId);
      await atomicWritePrivateTextFile(
        recordPath("consumer-retirements", consumerRecordId(environmentId)),
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
