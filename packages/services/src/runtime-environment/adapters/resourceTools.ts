import { join } from "node:path";
import { valid } from "semver";
import type { ResourceCollectionCandidate } from "../app/resourceControl.js";
import { isPathWithin } from "./backendPlatform.js";
import { inspectResourcePath, ResourceBudget, ResourceScanFailure, walkResources, type ResourceTreeEntry } from "./resourceFilesystem.js";
import { resourceNames, type ResourceReferences } from "./resourceReferences.js";

export interface ManagedResourceCandidate extends ResourceCollectionCandidate {
  lockPath: string;
  installRoot: string;
  entries: ResourceTreeEntry[];
}
const PLATFORM = /^(?:windows|macos)-(?:x64|arm64)$|^linux-(?:x64|arm64)(?:-musl)?$/u;

/** 与 toolBackend 的 mise/backendVersion/platformKey/data/{installs,downloads}/key/version 布局一致。 */
export async function scanManagedTools(root: string, budget: ResourceBudget): Promise<ManagedResourceCandidate[]> {
  const store = join(root, "tool-store");
  const result: ManagedResourceCandidate[] = [];
  for (const backend of await resourceNames(root, store, budget)) {
    if (backend !== "mise") throw new ResourceScanFailure("unavailable", "Unknown managed tool backend layout");
    const backendRoot = join(store, backend);
    for (const backendVersion of await resourceNames(root, backendRoot, budget)) {
      if (!backendVersion.startsWith("v") || valid(backendVersion.slice(1)) !== backendVersion.slice(1)) throw new ResourceScanFailure("unavailable", "Unknown managed backend version layout");
      const versionRoot = join(backendRoot, backendVersion);
      for (const platform of await resourceNames(root, versionRoot, budget)) {
        if (!PLATFORM.test(platform)) throw new ResourceScanFailure("unavailable", "Unknown managed tool platform layout");
        const platformRoot = join(versionRoot, platform);
        for (const kind of ["installs", "downloads"] as const) {
          const directory = join(platformRoot, "data", kind);
          for (const key of await resourceNames(root, directory, budget)) {
            if (key === ".mise-installs.toml") continue;
            if (key !== "node" && key !== "pnpm") throw new ResourceScanFailure("unavailable", "Unknown managed tool key");
            const keyRoot = join(directory, key);
            for (const version of await resourceNames(root, keyRoot, budget)) {
              // mise 的 major/latest 别名和元数据不属于可删除候选；只处理确切 semver 目录。
              if (valid(version) !== version) continue;
              const path = join(keyRoot, version);
              const entries: ResourceTreeEntry[] = [];
              await walkResources(root, path, budget, entries);
              if (!entries[0]?.directory) throw new ResourceScanFailure("unavailable", "Managed tool candidate is not a directory");
              const lockName = `${platform}-${key}-${version}`.replace(/[^A-Za-z0-9._-]/gu, "_");
              result.push({ path, kind: kind === "installs" ? "tool" : "download", state: "eligible", entries,
                installRoot: join(platformRoot, "data", "installs", key, version), lockPath: join(platformRoot, `${lockName}.lock`) });
            }
          }
        }
      }
    }
  }
  return result;
}

export async function validateProtectedTools(root: string, refs: ResourceReferences, extra: readonly string[], budget: ResourceBudget): Promise<void> {
  for (const path of extra) refs.protectedToolPaths.add(path);
  for (const path of refs.protectedToolPaths) {
    budget.take();
    if (!isPathWithin(join(root, "tool-store"), path)) throw new ResourceScanFailure("unavailable", "Managed reference path is outside the tool store");
    await inspectResourcePath(root, path);
    budget.check();
  }
}
export function isProtectedTool(candidate: ManagedResourceCandidate, refs: ResourceReferences): boolean {
  if (refs.protectAll) return true;
  return [...refs.protectedToolPaths].some((path) => isPathWithin(candidate.installRoot, path) || isPathWithin(path, candidate.installRoot) || isPathWithin(candidate.path, path));
}
