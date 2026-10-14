#!/usr/bin/env node
// 构建手机镜像 UI 产物:packages/web 完整客户端(vite)→ cfworker-remote/public/,
// 由 Workers Static Assets 托管(specs/mobile-remote-control-cf-workers.md「移动端」)。
//
// 与普通 `pnpm build` 的差异:
// - base 相对(--base=./):Worker 对 /p/:roomId 回退客户端 index.html，根路径精确路由官网
//   (cfworker-remote/PROTOCOL.md §1),配合 packages/web/index.html 的 <base href="/"
//   让资源始终解析到站点根,深链页不会请求 /p/assets/* 这类不存在的路径。
//   packages/web 自身的默认构建(base=/)不受影响。
// - 注入 LCODE_ENV(默认 production):vite.config.ts 用它选择 endpoint 常量与
//   sourcemap 策略,移动端产物按生产态构建;只允许注入公开链接常量,
//   凭据类值不得走 VITE_ 环境注入。
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { assembleMobileWeb } from "./mobile-web-assembly.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const webDir = resolve(repoRoot, "packages", "web");
const distDir = resolve(webDir, "dist");
const outputDir = resolve(repoRoot, "cfworker-remote", "public");

async function buildWeb() {
  // 仓库 .npmrc 配置 node-linker=hoisted,依赖提升到根 node_modules;
  // 兼容性起见先看 packages/web 本地,再回退根提升位置。
  const viteCandidates = [
    resolve(webDir, "node_modules", "vite", "bin", "vite.js"),
    resolve(repoRoot, "node_modules", "vite", "bin", "vite.js"),
  ];
  let viteEntry;
  for (const candidate of viteCandidates) {
    try {
      await access(candidate);
      viteEntry = candidate;
      break;
    } catch {
      // 尝试下一个候选位置
    }
  }
  if (!viteEntry) {
    throw new Error(
      `vite 未安装(已尝试:${viteCandidates.join(", ")});请先在仓库根执行 pnpm install`,
    );
  }

  await new Promise((resolveBuild, rejectBuild) => {
    const child = spawn(process.execPath, [viteEntry, "build", "--base=./"], {
      cwd: webDir,
      stdio: "inherit",
      env: {
        ...process.env,
        // 移动端产物默认生产态;本地调试可显式传 LCODE_ENV=test 覆盖。
        LCODE_ENV: process.env.LCODE_ENV?.trim() || "production",
      },
      windowsHide: true,
    });
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolveBuild();
        return;
      }
      rejectBuild(new Error(`vite build 退出:code=${code ?? "null"} signal=${signal ?? "null"}`));
    });
    child.on("error", rejectBuild);
  });
}

async function copyToWorkerPublic() {
  // 官网与客户端必须一起装配；单方 rm(public) 会删除另一方的页面和恢复入口。
  await assembleMobileWeb({ distDir, outputDir });
}

try {
  await buildWeb();
  await copyToWorkerPublic();
  console.info(`[build-mobile-web] packages/web/dist → ${outputDir}`);
} catch (error) {
  console.error("[build-mobile-web] 构建失败:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
