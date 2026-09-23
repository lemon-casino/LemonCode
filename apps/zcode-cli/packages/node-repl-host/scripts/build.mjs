import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const packageRoot = resolve(import.meta.dirname, "..");

// 见 browser-use-plugin/scripts/build.mjs 的同名修复：esbuild 的 esm 产物里
// __require shim 在 ESM 作用域没有 require 可用，@zcode/core 拖进来的 CJS 依赖（yaml →
// require("process")）会在**模块求值阶段**抛错，plugin host 的 await import() 直接失败，
// 表现为注册 0 个工具、模型侧完全看不到 mcp__node_repl__js。注入真实 createRequire。
const nodeRequireBanner = `import { createRequire as __zcodeCreateRequire } from "node:module";
const require = __zcodeCreateRequire(import.meta.url);`;

export const buildNodeReplHostBundle = async ({
  outfile = resolve(packageRoot, "dist", "mcp", "server.js"),
} = {}) => {
  await mkdir(dirname(outfile), { recursive: true });
  await build({
    banner: { js: nodeRequireBanner },
    bundle: true,
    entryPoints: [resolve(packageRoot, "src", "server.ts")],
    // CUA 本地输入驱动的运行时依赖必须外部化：server.ts 静态 import @zcode/zcode-cua，
    // 其驱动内部动态 import @nut-tree-fork/nut-js（含原生 .node）。不登记 external 时
    // esbuild 会把它 chase 进 dist/mcp/server.js 并在 .node 上构建失败/运行时崩溃。
    // CLI 运行时从自身 node_modules 解析（CLI 是本 build 唯一携带 addon 的分发面）。
    // 见 specs/computer-use-open-replacement.md「打包接线约束」。
    external: ["@nut-tree-fork/nut-js"],
    format: "esm",
    legalComments: "none",
    outfile,
    platform: "node",
    target: "node24",
  });
  return { outfile };
};

// 这里原先写成 `file://${process.argv[1]}`。
// Windows 上 argv[1] 是 `C:\...\build.mjs`，而 import.meta.url 是 `file:///C:/.../build.mjs`，
// 两者永远不相等 —— 脚本被当成纯模块导入，什么都不做就退出：构建"成功"却没有产物，
// 直到 dev 守卫报「build succeeded without required MCP runtime」才暴露。
// browser-use 的同名脚本与仓库其他入口都用 pathToFileURL，抽包时我漏了这一处。
const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  const { outfile } = await buildNodeReplHostBundle();
  console.log(`[node-repl-host] ${outfile}`);
}
