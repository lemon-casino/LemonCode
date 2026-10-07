import { open, opendir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  frozenManifestSchema, managedServiceReceiptSchema, runtimeConsumerReferenceSchema,
  runtimeEnvironmentRecordSchema, runtimePreparationOperationSchema,
  type FrozenManifest,
} from "@lcode/shared";
import { scopeKeyHash } from "../app/ports.js";
import { inspectResourcePath, ResourceBudget, ResourceScanFailure } from "./resourceFilesystem.js";

const MAX_RECORD_BYTES = 2 * 1024 * 1024;
const consumersSchema = z.object({ schemaVersion: z.literal(1), consumers: z.array(runtimeConsumerReferenceSchema).max(4096) }).strict();
const serviceIndexSchema = z.object({ serviceIds: z.array(z.string().min(1)).max(4096) }).strict();
function incomplete(message: string): never { throw new ResourceScanFailure("unavailable", message); }

export async function resourceNames(root: string, directory: string, budget: ResourceBudget): Promise<string[]> {
  budget.take();
  const stat = await inspectResourcePath(root, directory, true);
  budget.check();
  if (!stat) return [];
  if (!stat.isDirectory()) incomplete("Resource reference directory is invalid");
  const names: string[] = [];
  const handle = await opendir(directory, { bufferSize: 1 });
  try {
    while (true) {
      budget.check();
      const child = await handle.read();
      budget.check();
      if (!child) break;
      budget.take();
      names.push(child.name);
    }
  } finally { await handle.close(); }
  return names;
}

export async function readResourceJson(root: string, path: string, budget: ResourceBudget): Promise<unknown> {
  budget.take();
  const stat = await inspectResourcePath(root, path);
  if (!stat?.isFile() || stat.size > MAX_RECORD_BYTES) incomplete("Resource reference record is invalid or exceeds the read bound");
  const handle = await open(path, "r");
  try {
    const opened = await handle.stat();
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) incomplete("Resource reference changed while opening");
    const buffer = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    budget.check();
    if (bytesRead !== stat.size) incomplete("Resource reference changed while reading");
    return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
  } finally { await handle.close(); }
}

async function recordFiles(root: string, kind: string, budget: ResourceBudget): Promise<Map<string, unknown>> {
  const directory = join(root, kind);
  const records = new Map<string, unknown>();
  for (const name of await resourceNames(root, directory, budget)) {
    // 未知文件可能是并发 atomic write 的临时记录；不能忽略后宣称引用全集已证明。
    if (!/^[a-f0-9]{32}\.json$/u.test(name)) incomplete("Resource reference inventory contains an unknown or changing record");
    records.set(name.slice(0, -5), await readResourceJson(root, join(directory, name), budget));
  }
  return records;
}

export interface ResourceReferences {
  protectedToolPaths: Set<string>;
  protectedReferences: number;
  referencesByEnvironment: Map<string, number>;
  protectAll: boolean;
  reason?: string;
}

/** 遍历事实全集而不是 listEnvironments 的宽松文件过滤；孤儿、旧版本或损坏记录一律拒绝 GC。 */
export async function scanResourceReferences(root: string, budget: ResourceBudget): Promise<ResourceReferences> {
  const result: ResourceReferences = { protectedToolPaths: new Set(), protectedReferences: 0, referencesByEnvironment: new Map(), protectAll: false };
  const environments = new Map<string, z.infer<typeof runtimeEnvironmentRecordSchema>>();
  const manifests = new Map<string, FrozenManifest>();
  const required = new Map<string, Set<number>>();
  const matchedManifests = new Set<string>();
  const protect = (id: string, revision: number) => {
    if (!environments.has(id) || revision <= 0) incomplete("Resource reference has no valid environment revision");
    const revisions = required.get(id) ?? new Set<number>();
    revisions.add(revision);
    required.set(id, revisions);
    result.protectedReferences++;
    result.referencesByEnvironment.set(id, (result.referencesByEnvironment.get(id) ?? 0) + 1);
  };
  const protectAll = () => {
    result.protectAll = true;
    result.reason = "Preparation is active or its exit is unconfirmed; all managed tools are protected";
  };
  for (const [id, value] of await recordFiles(root, "records", budget)) {
    const record = runtimeEnvironmentRecordSchema.parse(value);
    if (record.environmentId !== id || record.stateRevision === undefined) incomplete("Environment identity or state revision is unverified");
    environments.set(id, record);
    if (["allocated", "resolvingTools", "installingTools", "preparingDependencies", "cancelling"].includes(record.status)) protectAll();
    if (record.currentRevision > 0 && record.status !== "released") protect(id, record.currentRevision);
    if (record.currentRevision === 0 && record.status !== "released") protectAll();
  }
  for (const [id, value] of await recordFiles(root, "manifests", budget)) {
    const manifest = frozenManifestSchema.parse(value);
    if (!manifest.manifestDigest) incomplete("Legacy manifest has no verifiable digest");
    for (const tool of manifest.tools) {
      budget.take();
      if (tool.installStrategy !== "system-path" && !tool.toolPath) incomplete("Managed manifest has an unresolved tool path");
    }
    manifests.set(id, manifest);
  }
  const consumerOwners = new Map([...environments.keys()].map((id) => [scopeKeyHash(["consumers", id]), id]));
  for (const [id, value] of await recordFiles(root, "consumers", budget)) {
    const environmentId = consumerOwners.get(id);
    if (!environmentId) incomplete("Orphan consumer record prevents a complete reference proof");
    const record = consumersSchema.parse(value);
    const identities = new Set<string>();
    for (const consumer of record.consumers) {
      budget.take();
      const key = JSON.stringify([consumer.kind, consumer.id]);
      if (consumer.environmentId !== environmentId || identities.has(key)) incomplete("Consumer identity is corrupt");
      identities.add(key);
      if (consumer.state === "active") protect(environmentId, consumer.revision);
    }
  }
  const serviceIndexOwners = new Map([...environments.keys()].map((id) => [scopeKeyHash(["service-index", id]), id]));
  const serviceIndexes = new Map<string, Set<string>>();
  const serviceReceipts = new Map<string, Set<string>>();
  for (const [id, value] of await recordFiles(root, "services", budget)) {
    const indexOwner = serviceIndexOwners.get(id);
    if (indexOwner) {
      const { serviceIds } = serviceIndexSchema.parse(value);
      for (const _ of serviceIds) budget.take();
      if (new Set(serviceIds).size !== serviceIds.length) incomplete("Duplicate service index entry");
      serviceIndexes.set(indexOwner, new Set(serviceIds));
      continue;
    }
    const receipt = managedServiceReceiptSchema.parse(value);
    if (scopeKeyHash(["service", receipt.environmentId, receipt.serviceId]) !== id || !environments.has(receipt.environmentId)) incomplete("Orphan or mismatched service receipt");
    const ids = serviceReceipts.get(receipt.environmentId) ?? new Set<string>();
    ids.add(receipt.serviceId);
    serviceReceipts.set(receipt.environmentId, ids);
    // stopped 状态本身不是退出证明；failed 同样必须带真实 stoppedAt 才能释放保护。
    if (!((receipt.state === "stopped" || receipt.state === "failed") && receipt.stoppedAt)) protect(receipt.environmentId, receipt.revision);
  }
  for (const environmentId of new Set([...serviceIndexes.keys(), ...serviceReceipts.keys()])) {
    const indexed = serviceIndexes.get(environmentId) ?? new Set();
    const receipts = serviceReceipts.get(environmentId) ?? new Set();
    if (indexed.size !== receipts.size || [...indexed].some((id) => !receipts.has(id))) incomplete("Service index and receipts are incomplete");
  }
  const operations = new Map<string, z.infer<typeof runtimePreparationOperationSchema>>();
  for (const [id, value] of await recordFiles(root, "operations", budget)) {
    const operation = runtimePreparationOperationSchema.parse(value);
    if (operation.operationId !== id) incomplete("Preparation identity is corrupt");
    operations.set(id, operation);
    if (operation.status === "running") protectAll();
    // 成功计划只含安装前确切版本，缺 toolPath 不是活安装证明；引用由 immutable manifest 保护。
    // 已取消计划同理，真正未退出的 writer/安装仍由 activeOperationId、executions 和安装锁保护。
    if (operation.status === "succeeded" || operation.status === "cancelled") continue;
    const owner = environments.get(operation.environmentId);
    if (operation.plan && !owner) protectAll();
    if (operation.plan && owner?.status !== "released") {
      for (const tool of operation.plan.tools) {
        budget.take();
        if (tool.toolPath) result.protectedToolPaths.add(tool.toolPath);
        else protectAll();
      }
    }
  }
  // claimPreparation 使用 <id>.json.lock；存在即保护，绝不按时间回收 lease/未知锁。
  if ((await resourceNames(root, join(root, "executions"), budget)).length) protectAll();
  for (const record of environments.values()) {
    if (record.activeOperationId) {
      // active 字段直到真实 writer/进程结算才清除；failed/cancelled 收据不能提前解除全局保护。
      protectAll();
      const operation = operations.get(record.activeOperationId);
      if (!operation || operation.environmentId !== record.environmentId) incomplete("Environment preparation reference is incomplete");
    }
    for (let revision = 1; revision <= record.currentRevision; revision++) {
      budget.take();
      const id = scopeKeyHash(["manifest", record.environmentId, revision]);
      const manifest = manifests.get(id);
      if (!manifest) incomplete("Immutable manifest history is incomplete");
      if (revision === record.currentRevision && manifest.manifestDigest !== record.manifestDigest) incomplete("Environment manifest digest is unverified");
      matchedManifests.add(id);
      if (required.get(record.environmentId)?.has(revision)) for (const tool of manifest.tools) {
        budget.take();
        if (tool.toolPath && tool.installStrategy !== "system-path") result.protectedToolPaths.add(tool.toolPath);
      }
    }
    for (const revision of required.get(record.environmentId) ?? []) {
      if (revision > record.currentRevision) incomplete("A live reference points to an unpublished revision");
    }
  }
  if (matchedManifests.size !== manifests.size) incomplete("Orphan immutable manifest prevents a complete reference proof");
  budget.check();
  return result;
}
