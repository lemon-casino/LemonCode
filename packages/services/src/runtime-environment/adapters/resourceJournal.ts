import { join } from "node:path";
import { z } from "zod";
import { runtimeEnvironmentGarbageCollectionResultSchema } from "@lcode/shared";
import { acquireFileLock, atomicWritePrivateTextFile } from "@lcode/shared/node";
import { scopeKeyHash } from "../app/ports.js";
import type { ResourceCollectionParams, ResourceCollectionResult } from "../app/resourceControl.js";
import { ensureResourceDirectory, inspectResourcePath, ResourceBudget, ResourceScanFailure } from "./resourceFilesystem.js";
import { readResourceJson } from "./resourceReferences.js";

const collectionResultSchema = runtimeEnvironmentGarbageCollectionResultSchema.extend({
  candidates: z.array(z.object({ path: z.string(), kind: z.enum(["tool", "download"]), state: z.enum(["eligible", "protected", "deleted"]) }).strict()),
}).strict();
const journalSchema = z.object({ schemaVersion: z.literal(1), fingerprint: z.string(), settled: z.boolean(), result: collectionResultSchema }).strict();

export async function openResourceJournal(root: string, params: ResourceCollectionParams, budget: ResourceBudget) {
  if (!/^[a-f0-9]{32}$/u.test(params.operationId)) throw new Error("Invalid resource GC operation id");
  const directory = join(root, "resource-gc");
  await ensureResourceDirectory(root, directory);
  budget.check();
  // 与安装锁相同的底层互斥，不等待/不清理超时或无主锁；别的 GC 活跃时留给调用方显式重试。
  const release = await acquireFileLock(join(directory, "collector"), [], 0, 0);
  const path = join(directory, `${params.operationId}.json`);
  const fingerprint = scopeKeyHash([params.dryRun, params.budget, [...params.protectedToolPaths ?? []].sort()]);
  try {
    const present = await inspectResourcePath(root, path, true);
    const previous = present ? journalSchema.parse(await readResourceJson(root, path, budget)) : undefined;
    if (previous && previous.fingerprint !== fingerprint) throw new Error("stale-reference: GC requestId already has different parameters");
    return {
      release,
      previous,
      async save(result: ResourceCollectionResult, settled: boolean) {
        await inspectResourcePath(root, directory);
        const existing = await inspectResourcePath(root, path, true);
        if (existing && !existing.isFile()) throw new ResourceScanFailure("unavailable", "GC journal path is not a regular file");
        const journal = journalSchema.parse({ schemaVersion: 1, fingerprint, settled, result });
        // 写前意图与写后结算都落盘；重启只重放收据，不对重新安装的同路径再次执行旧请求。
        await atomicWritePrivateTextFile(path, `${JSON.stringify(journal)}\n`, []);
      },
    };
  } catch (error) { await release(); throw error; }
}
