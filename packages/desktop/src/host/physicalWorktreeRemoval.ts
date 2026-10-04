import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
/** Electron 的 ASAR fs 补丁会把依赖包的归档当目录；受管目录删除必须使用物理 fs。 */
export async function removePhysicalWorktreeDirectory(path: string): Promise<void> {
  const physicalFs = require("original-fs") as typeof import("node:fs");
  await physicalFs.promises.rm(path, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
