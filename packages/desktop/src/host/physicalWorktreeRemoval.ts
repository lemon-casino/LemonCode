import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
/** Electron 会把 ASAR 当目录；checkout 与固定可重建资源根均由各 owner 校验后使用物理 fs。 */
export async function removePhysicalWorktreeDirectory(path: string): Promise<void> {
  const physicalFs = require("original-fs") as typeof import("node:fs");
  await physicalFs.promises.rm(path, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
