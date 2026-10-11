#!/usr/bin/env node

// 桌面打包态的 agent 运行时资产：把 agent 的 JS bundle（lcode.cjs）放进 bundled-agents/<platform>/glm，
// 由 app 内置的 Electron Node runtime（ELECTRON_RUN_AS_NODE）执行，替代以前随包内置的独立 Node 二进制。
//
// 为什么这么做：
// - agent 的 koffi 使用 N-API；共享 staging 复制目标平台原生产物，可跑在 Electron 的 Node 上；
// - Electron 41 内置 Node 24.x，与 lcode-cli 的目标运行时一致；
// - 单平台体积从 ~180MB 降到 ~16MB，且同一份 JS 跨平台通用；
// - app-server 命令路径不会加载 @lcode/tui，所以这里天然不打包 TUI。
//
// 远端（SSH/WSL/Docker）没有 Electron，仍走 prepare:remote-assets 的原生二进制，互不影响。

import { cpSync, existsSync, mkdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runCommand } from "../../../scripts/spawn-command.mjs";
import { stageAgentBundle } from "./stage-agent-bundle.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const cliBundlePath = resolve(repoRoot, "apps/lcode-cli/packages/cli/dist/lcode.cjs");
const pnpmRunEnv = {
  ...process.env,
  // pnpm 11 会在 apps/lcode-cli 子 workspace 执行 run 前触发 install；
  // 子 workspace 不能解析根 workspace 的 @lcode/shared，Docker/web app 打包会因此卡在插件 runtime 构建。
  PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "false",
};

// 平台目录命名：darwin/win32/linux + x64/arm64，
// 支持 LCODE_TARGET_OS / LCODE_TARGET_ARCH 覆盖（交叉打包时由 CI 注入）。
function normalizePlatform(raw) {
  switch (raw) {
    case "mac":
    case "macos":
    case "darwin":
    case "osx":
      return "darwin";
    case "win":
    case "windows":
    case "win32":
      return "win32";
    case "linux":
      return "linux";
    default:
      return raw;
  }
}

function normalizeArch(raw) {
  switch (raw) {
    case "x86_64":
    case "x64":
    case "amd64":
      return "x64";
    case "aarch64":
    case "arm64":
      return "arm64";
    default:
      return raw;
  }
}

const platform = normalizePlatform(process.env.LCODE_TARGET_OS || "") || process.platform;
const arch = normalizeArch(process.env.LCODE_TARGET_ARCH || "") || process.arch;
const platformKey = `${platform}-${arch}`;

const glmDir = resolve(desktopRoot, "bundled-agents", platformKey, "glm");
// lcode.cjs / .node-bundle-meta.json 的落点由 stage-agent-bundle.mjs 自己解析（同源）。
// node_repl 宿主抽成独立包
// @lcode/node-repl-host 之后，browser-use 不再产出 dist/mcp/server.js，CUA 资产
// （docs/computer-use.md、scripts/computer-use-client.mjs）也已归 @lcode/lcode-cua-plugin。
// 编译统一由 build-desktop-agent-cli.mjs 执行；这里登记的是目标安装包需要校验和复制的资产。
// browser-use 不承担 node_repl/CUA 的入口，权威归属见 bootstrap/official-plugin-definitions.ts。
const browserUseRequiredRuntimePaths = [
  "scripts/browser-client.mjs",
  "docs/api.json",
  "docs/documents.json",
  "docs/overview.md",
  // documents.json 已暴露 recording lookup，桌面安装包不能复用缺少正文的 runtime。
  "docs/recording.md",
  "docs/workflow.md",
  "skills/control-browser/SKILL.md",
  "skills/web-gui-tester/SKILL.md",
];
const officialPluginPackages = [
  {
    // browser-use 只携带自己的 client script 与 skill/docs；node_repl MCP runtime 归
    // @lcode/node-repl-host（见上方常量注释）。
    packageName: "@lcode/browser-use-plugin",
    relativePath: "apps/lcode-cli/packages/browser-use-plugin",
    requiresRuntime: true,
    requiredRuntimePaths: browserUseRequiredRuntimePaths,
    stagedPath: "packages/browser-use-plugin",
  },

  {
    // node_repl 宿主：Browser Use 与 Computer Use 共用的 MCP runtime，本轮抽成独立包。
    // 它没有 listing（不进插件市场展示面），但生产包首启 seed 必须拿到它的 dist runtime，
    // 否则 bua/cua 任一开启时都会连不上 node_repl。
    packageName: "@lcode/node-repl-host",
    relativePath: "apps/lcode-cli/packages/node-repl-host",
    requiresRuntime: true,
    requiredRuntimePaths: ["dist/mcp/server.js"],
    stagedPath: "packages/node-repl-host",
  },
  {
    // Bug 修复：只在源码树注册内容插件会让 dev 可见、安装包缺失。生产资源必须把同一份
    // /lemon 命令与技能复制到 lcode.cjs 同级的 packages/，首启才能完成 filesystem seed。
    packageName: "@lcode/lemon-workflow-plugin",
    relativePath: "apps/lcode-cli/packages/lemon-workflow-plugin",
    requiresRuntime: false,
    requiredSeedPaths: [
      "commands/lemon.md",
      "skills/ponytail/SKILL.md",
      "skills/caveman/SKILL.md",
      "skills/dynamic-workflows/SKILL.md",
      "skills/dynamic-workflows/examples.md",
      "skills/dynamic-workflows/patterns.md",
    ],
    stagedPath: "packages/lemon-workflow-plugin",
  },
  {
    // Computer Use 本身是内容包，node_repl-host 才是 executable host。生产 staging
    // 仍必须显式复制 SDK/docs/skill；否则开发机 cache 会掩盖干净安装缺包。
    packageName: "@lcode/lcode-cua-plugin",
    relativePath: "apps/lcode-cli/packages/lcode-cua-plugin",
    requiresRuntime: false,
    requiredSeedPaths: [
      "docs/computer-use.md",
      "scripts/computer-use-client.mjs",
      "skills/computer-use/SKILL.md",
    ],
    stagedPath: "packages/lcode-cua-plugin",
  },
];
const includedOfficialPluginTopLevelPaths = new Set([
  ".mcp.json",
  ".lcode-plugin",
  "README.md",
  // Electron 生产资源复制有独立白名单，遗漏 agents 会让首启 filesystem seed 永久缺少子代理。
  "agents",
  "commands",
  "dist",
  "docs",
  "hooks",
  "output-styles",
  "package.json",
  "scripts",
  "skills",
  "templates",
]);
const excludedOfficialPluginAssetNames = new Set([
  ".DS_Store",
  ".venv",
  "__pycache__",
  "node_modules",
]);

function shouldCopyOfficialPluginAsset(sourcePath) {
  const name = basename(sourcePath);
  return !excludedOfficialPluginAssetNames.has(name) && !name.endsWith(".pyc");
}

function buildCliBundle() {
  console.log("[prepare:agent-bundle] building lcode-cli app-server bundle ...");
  // 复用仓库根脚本（turbo build:desktop-agent --filter=@lcode/cli），命中缓存时几乎瞬时。
  runCommand(
    process.execPath,
    [resolve(repoRoot, "scripts/build-desktop-agent-cli.mjs"), "--no-stage"],
    {
      cwd: repoRoot,
      env: pnpmRunEnv,
    },
  );
  if (!existsSync(cliBundlePath)) {
    throw new Error(
      `[prepare:agent-bundle] expected cli bundle missing after build: ${cliBundlePath}`,
    );
  }
}

function verifyOfficialPluginRuntimes() {
  for (const plugin of officialPluginPackages) {
    if (!plugin.requiresRuntime) continue;
    // 编译由 build-desktop-agent-cli.mjs 统一执行，打包入口只校验本次目标要复制的资产。
    assertOfficialPluginRuntime(plugin);
  }
}

function assertOfficialPluginRuntime(plugin) {
  const pluginRoot = resolve(repoRoot, plugin.relativePath);
  for (const relativePath of plugin.requiredRuntimePaths) {
    const runtimePath = resolve(pluginRoot, ...relativePath.split("/"));
    if (!existsSync(runtimePath)) {
      throw new Error(`[prepare:agent-bundle] missing official plugin runtime: ${runtimePath}`);
    }
  }
}

async function stageBundle() {
  // 实现已抽到 stage-agent-bundle.mjs：dev 链（scripts/build-desktop-agent-cli.mjs）
  // 必须用同一份，否则 dev 会继续跑上一次打包留下的陈旧 agent。
  await stageAgentBundle({ repoRoot, platformKey });
}

function stageOfficialPlugins() {
  for (const plugin of officialPluginPackages) {
    const sourceRoot = resolve(repoRoot, plugin.relativePath);
    const manifestPath = resolve(sourceRoot, ".lcode-plugin", "plugin.json");
    if (!existsSync(manifestPath)) {
      throw new Error(`[prepare:agent-bundle] missing official plugin manifest: ${manifestPath}`);
    }

    const targetRoot = resolve(glmDir, plugin.stagedPath);
    mkdirSync(targetRoot, { recursive: true });
    for (const entryName of includedOfficialPluginTopLevelPaths) {
      const sourcePath = resolve(sourceRoot, entryName);
      if (!existsSync(sourcePath)) continue;
      cpSync(sourcePath, resolve(targetRoot, entryName), {
        recursive: true,
        filter: shouldCopyOfficialPluginAsset,
      });
    }
    for (const relativePath of plugin.requiredSeedPaths ?? []) {
      const stagedAssetPath = resolve(targetRoot, ...relativePath.split("/"));
      if (!existsSync(stagedAssetPath)) {
        throw new Error(
          `[prepare:agent-bundle] missing staged official plugin seed asset: ${stagedAssetPath}`,
        );
      }
    }
    console.log(`[prepare:agent-bundle] staged official plugin ${plugin.stagedPath}`);
  }
}

// Electron 生产包只带 resources/glm/lcode.cjs 时，app-server 进程的
// __dirname 附近没有官方插件目录，启动时 seed 找不到 source，用户侧不会自动得到内置插件。
// 这里把官方插件按 bootstrap 的 rootCandidates 期望放到 glm/packages/*-plugin，
// 让 Electron Node 运行 lcode.cjs 时复用同一套 filesystem seed 逻辑。
// browser-use runtime 的声明生成依赖 @lcode/core/dist。CI 干净检出没有该产物，
// 必须先构建 CLI 依赖，再构建官方插件；开发机残留的 dist 曾掩盖这个顺序问题。
buildCliBundle();
verifyOfficialPluginRuntimes();
await stageBundle();
stageOfficialPlugins();
