import { join, resolve } from "node:path";
import { rm } from "node:fs/promises";
import { type ResourcePort } from "../app/resourceControl.js";
import type { RuntimeResourceDirectoryRemover } from "../contract.js";
import { environmentResourceDirs } from "./store.js";
import { collectResources } from "./resourceCollection.js";
import {
  ensureResourceDirectory,
  inspectResourcePath,
  ResourceBudget,
  resourceFailure,
  summarizeResources,
  walkResources,
  type ResourceTreeEntry,
} from "./resourceFilesystem.js";

/** 私有资源由环境 owner 调用；不接受任意路径，data 只在明确 discard 时移除。 */
export function createRuntimeResources(
  dataDir: string,
  removeDirectory: RuntimeResourceDirectoryRemover = (path) =>
    rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
): ResourcePort {
  const root = resolve(dataDir);
  return {
    collect: (params) => collectResources(root, params),
    async ensure(environmentId) {
      const { environmentRoot: _, ...privateDirs } = environmentResourceDirs(root, environmentId);
      const resources = { ...privateDirs, packageStore: join(root, "package-store", "pnpm") };
      for (const path of Object.values(resources)) await ensureResourceDirectory(root, path);
      return resources;
    },
    async scan(environmentId, limits) {
      const dirs = environmentResourceDirs(root, environmentId);
      const budget = new ResourceBudget(limits);
      const entries: ResourceTreeEntry[] = [];
      try {
        for (const key of ["temp", "cache", "data", "logs"] as const)
          await walkResources(root, dirs[key], budget, entries);
        return summarizeResources(budget, entries);
      } catch (error) {
        return summarizeResources(budget, entries, resourceFailure(error));
      }
    },
    async clearRebuildable(environmentId) {
      const dirs = environmentResourceDirs(root, environmentId);
      const targets = [];
      // 关闭占用后直接清理固定根：全量预扫描与逐项校验共用 2 秒预算会反复超时，阻止删除完成。
      // 先检查全部根，根/祖先重定向时不提前删掉另一个根；原生递归删除只移除后代链接自身。
      for (const key of ["temp", "cache", "logs"] as const) {
        const stat = await inspectResourcePath(root, dirs[key], true);
        if (stat) targets.push({ path: dirs[key], stat });
      }
      for (const target of targets) {
        const current = await inspectResourcePath(root, target.path, true);
        if (!current) continue;
        if (
          current.dev !== target.stat.dev ||
          current.ino !== target.stat.ino ||
          current.isDirectory() !== target.stat.isDirectory()
        )
          throw resourceFailure(new Error("Managed resource root changed before deletion"));
        await removeDirectory(target.path);
      }
    },
    async discard(environmentId) {
      const dirs = environmentResourceDirs(root, environmentId);
      // 只清缓存会留下数据库占用空间；明确删除已授权本环境全部私有资源，归档不走此入口。
      const before = await inspectResourcePath(root, dirs.environmentRoot, true);
      if (!before) return;
      if (!before.isDirectory())
        throw new Error("Managed private resource root is not a directory");
      for (const key of ["temp", "cache", "data", "logs"] as const)
        await inspectResourcePath(root, dirs[key], true);
      const current = await inspectResourcePath(root, dirs.environmentRoot, true);
      if (!current) return;
      if (current.dev !== before.dev || current.ino !== before.ino || !current.isDirectory())
        throw new Error("Managed private resource root changed before deletion");
      await removeDirectory(dirs.environmentRoot);
      if (await inspectResourcePath(root, dirs.environmentRoot, true))
        throw new Error("Managed private resource root still exists after removal");
    },
  };
}
