import { access, cp, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { buildWebsite } from "../cfworker-remote/site/build.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
export async function assembleMobileWeb({ distDir, outputDir, buildSite = buildWebsite }) {
  const target = resolve(outputDir);
  const parent = dirname(target);
  if (basename(target) !== "public" || target === parent)
    throw new Error("invalid assembly target");
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(resolve(parent, ".public-stage-"));
  const backup = `${staging}-previous`;
  // Windows 递归清理只允许本次明确创建的同父目录产物，不删除用户工作区或 public。
  const removeOwned = async (path) => {
    if (dirname(resolve(path)) !== parent || !basename(path).startsWith(".public-stage-"))
      throw new Error("invalid cleanup target");
    await rm(path, { recursive: true, force: true });
  };
  let oldMoved = false;
  try {
    await cp(distDir, staging, { recursive: true, filter: (source) => !source.endsWith(".map") });
    await buildSite(resolve(staging, "site"));
    // 工具依赖由独立 Worker 声明；只把 Web 自己的轻量入口打包，不引入应用 bootstrap。
    const workerRequire = createRequire(resolve(repoRoot, "cfworker-remote/package.json"));
    const { build } = workerRequire("esbuild");
    await build({
      entryPoints: [resolve(repoRoot, "packages/web/src/remote/rootRecoveryEntry.ts")],
      bundle: true,
      format: "esm",
      platform: "browser",
      minify: true,
      outfile: resolve(staging, "site/assets/remote-entry.js"),
    });
    const required = [
      "index.html",
      "site/index.html",
      "site/download.html",
      "site/remote.html",
      "site/assets/site.css",
      "site/assets/site.js",
      "site/assets/remote-entry.js",
      "site/assets/logo.png",
      "site/assets/providers/sources.json",
      "site/assets/providers/NOTICE.txt",
    ];
    for (const file of required) await access(resolve(staging, file));
    for (const file of [
      "index.html",
      "site/index.html",
      "site/download.html",
      "site/remote.html",
    ]) {
      const html = await readFile(resolve(staging, file), "utf8");
      for (const match of html.matchAll(
        /(?:src|href)="((?:\/site\/assets\/|\.\/assets\/|\/assets\/)[^"]+)"/g,
      )) {
        const asset = resolve(staging, match[1].replace(/^\/?(?:\.\/)?/, ""));
        const local = relative(staging, asset);
        if (local.startsWith(`..${sep}`) || local === "..")
          throw new Error("asset escapes assembly");
        await access(asset);
      }
    }
    try {
      await rename(target, backup);
      oldMoved = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    try {
      await rename(staging, target);
    } catch (error) {
      if (oldMoved) await rename(backup, target);
      throw error;
    }
  } finally {
    await removeOwned(staging);
  }
  if (oldMoved) await removeOwned(backup);
}
