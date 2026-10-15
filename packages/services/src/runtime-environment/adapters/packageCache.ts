import { opendir, lstat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { StorageCleanResult } from "@lcode/shared";
import { acquireFileLock } from "@lcode/shared/node";
import type { IRuntimePackageCacheCleaner } from "../contract.js";
import { runBackendCommand } from "./backendCommand.js";
import { inspectResourcePath } from "./resourceFilesystem.js";
import { resolvePackageCacheTools } from "./packageCacheTools.js";
import { withPackageStoreLease } from "./packageStoreLease.js";

const CACHE_RELATIVE_PATH = "v2/runtime-environments/package-store/pnpm";
const emptyResult = (): StorageCleanResult => ({
  freedBytes: 0,
  deletedCount: 0,
  skippedCount: 0,
  failures: [],
});

/** 大缓存不受工具 GC 的 2 秒预算限制；异步枚举普通文件，绝不跟随项目注册链接。 */
async function inventory(store: string): Promise<Map<string, number>> {
  const files = new Map<string, number>();
  const directories = [store];
  for (let directory = directories.pop(); directory; directory = directories.pop()) {
    const handle = await opendir(directory);
    for await (const entry of handle) {
      const path = join(directory, entry.name);
      const key = relative(store, path).split(sep).join("/");
      if (key.startsWith(".lcode-package-operation")) continue;
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) {
        if (/^v\d+\/projects\/[^/]+$/u.test(key)) continue;
        throw new Error("unsafe package cache path");
      }
      if (stat.isDirectory()) directories.push(path);
      else if (stat.isFile()) files.set(key, stat.size);
    }
  }
  return files;
}

export function createRuntimePackageCacheCleaner(
  options: { runCommand?: typeof runBackendCommand } = {},
): IRuntimePackageCacheCleaner {
  const run = options.runCommand ?? runBackendCommand;
  return {
    async clean(dataRootPath) {
      const result = emptyResult();
      let failureCode = "EUNSAFEPATH";
      const dataRoot = resolve(dataRootPath);
      const runtime = join(dataRoot, "v2/runtime-environments");
      const store = join(dataRoot, CACHE_RELATIVE_PATH);
      const cache = join(store, "metadata-cache");
      try {
        if (!(await inspectResourcePath(dataRoot, store, true))) return result;
        await inspectResourcePath(dataRoot, cache, true);
        return await withPackageStoreLease(store, async () => {
          await inspectResourcePath(dataRoot, store);
          const before = await inventory(store);
          if (!before.size) return result;
          failureCode = "ETOOLUNAVAILABLE";
          const tools = await resolvePackageCacheTools(runtime);
          const releases: (() => Promise<void>)[] = [];
          try {
            for (const lock of tools.locks) releases.push(await acquireFileLock(lock, [], 0, 0));
            await inspectResourcePath(runtime, tools.node);
            await inspectResourcePath(runtime, tools.pnpm);
            failureCode = "EUNSAFEPATH";
            const env = { ...process.env };
            // 固定 cwd、显式 store/cache 与冻结入口，避免借项目配置切换 pnpm 或清理用户全局缓存。
            for (const key of Object.keys(env))
              if (/^(?:npm_config_|pnpm_|corepack_|mise_)/iu.test(key)) delete env[key];
            const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
            env[pathKey] =
              `${dirname(tools.node)}${process.platform === "win32" ? ";" : ":"}${env[pathKey] ?? ""}`;
            const args = [
              ...tools.command.prefix,
              "--store-dir",
              store,
              `--config.cache-dir=${cache}`,
              "--config.manage-package-manager-versions=false",
              "--config.package-manager-strict=false",
              "--reporter=append-only",
              "store",
            ];
            const settings = { cwd: store };
            const located = await run(tools.command.executable, [...args, "path"], env, settings);
            const reported = relative(store, resolve(located.stdout.trim()));
            if (located.code !== 0 || !/^v\d+$/u.test(reported))
              throw new Error("unsafe package cache target");
            await inspectResourcePath(dataRoot, store);
            await inspectResourcePath(dataRoot, cache, true);
            await inspectResourcePath(dataRoot, resolve(located.stdout.trim()));
            failureCode = "EPNPMPRUNE";
            let failed = false;
            try {
              failed =
                (await run(tools.command.executable, [...args, "prune"], env, settings)).code !== 0;
            } catch {
              failed = true;
            }
            const after = await inventory(store);
            for (const [path, bytes] of before)
              if (!after.has(path)) {
                result.freedBytes += bytes;
                result.deletedCount += 1;
              }
            result.skippedCount = before.size - result.deletedCount;
            if (failed) result.failures.push({ path: CACHE_RELATIVE_PATH, code: "EPNPMPRUNE" });
            return result;
          } finally {
            for (const release of releases.reverse()) await release();
          }
        });
      } catch (error) {
        const code =
          (error as NodeJS.ErrnoException).code === "LCODE_FILE_LOCK_TIMEOUT"
            ? "EBUSY"
            : failureCode;
        result.failures.push({ path: CACHE_RELATIVE_PATH, code });
        return result;
      }
    },
  };
}
