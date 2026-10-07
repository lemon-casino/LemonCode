import { join, resolve } from "node:path";
import { MAX_RESOURCE_SCAN_BUDGET, type ResourcePort } from "../app/resourceControl.js";
import { environmentResourceDirs } from "./store.js";
import { collectResources } from "./resourceCollection.js";
import {
  ensureResourceDirectory,
  inspectResourcePath,
  removeResourceTree,
  ResourceBudget,
  resourceFailure,
  summarizeResources,
  walkResources,
  type ResourceTreeEntry,
} from "./resourceFilesystem.js";

/** 私有资源由环境 owner 调用；本 adapter 从不接受 checkout 路径或删除 data。 */
export function createRuntimeResources(dataDir: string): ResourcePort {
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
        for (const key of ["temp", "cache", "data", "logs"] as const) await walkResources(root, dirs[key], budget, entries);
        return summarizeResources(budget, entries);
      } catch (error) { return summarizeResources(budget, entries, resourceFailure(error)); }
    },
    async clearRebuildable(environmentId) {
      const dirs = environmentResourceDirs(root, environmentId);
      const budget = new ResourceBudget(MAX_RESOURCE_SCAN_BUDGET);
      const entries: ResourceTreeEntry[] = [];
      // 先验证全部待删内容：发现软链/预算不足不能先删 temp 再把 cache 检查失败吞掉。
      for (const key of ["temp", "cache", "logs"] as const) {
        if (await inspectResourcePath(root, dirs[key], true)) await walkResources(root, dirs[key], budget, entries);
      }
      if (budget.entries + entries.length > budget.limits.maxEntries) throw resourceFailure(new Error("clear budget exhausted"));
      await removeResourceTree(root, entries, budget);
    },
  };
}
