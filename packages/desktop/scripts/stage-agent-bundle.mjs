// Agent bundle 的暂存动作：把 apps/lcode-cli/packages/cli/dist/lcode.cjs 放进
// bundled-agents/<平台>/glm，并写 meta。
//
// dev 与打包**必须**用同一份暂存实现。
// 只有打包链（prepare-agent-node-bundle.mjs）会暂存是不够的，dev 链
// （scripts/build-desktop-agent-cli.mjs）不会；而 dev 未打包时的 agent 二进制由
// desktopRuntimeEnv.ts 的 resolveBundledLCodeAgentBinaryPath() 解析，候选**只有**
// bundled-agents/，没有 cli/dist/。于是 dev 一直跑着上一次打包时留下的那份 ——
// 实测陈旧 3 天，任何 agent CLI 侧改动在 dev 里静默不生效，排查时会把「改动没生效」
// 误判成「代码没起作用」。两边共用这一份，dev 与打包不可能再各自漂移。
import { copyFile, cp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { stageKoffiIntoBundledAgents } from "./koffi-package-assets.mjs";

export const AGENT_BUNDLE_SOURCE_RELATIVE = "apps/lcode-cli/packages/cli/dist/lcode.cjs";
const LEMON_PLUGIN_SOURCE_RELATIVE = "apps/lcode-cli/packages/lemon-workflow-plugin";
const LEMON_PLUGIN_REQUIRED_PATHS = [
  ".lcode-plugin/plugin.json",
  "commands/lemon.md",
  "skills/ponytail/SKILL.md",
  "skills/caveman/SKILL.md",
  "skills/dynamic-workflows/SKILL.md",
  "skills/dynamic-workflows/examples.md",
  "skills/dynamic-workflows/patterns.md",
];
const CUA_PLUGIN_SOURCE_RELATIVE = "apps/lcode-cli/packages/lcode-cua-plugin";
const CUA_PLUGIN_REQUIRED_PATHS = [
  ".lcode-plugin/plugin.json",
  "docs/computer-use.md",
  "scripts/computer-use-client.mjs",
  "skills/computer-use/SKILL.md",
];

async function assertFile(path, message) {
  try {
    if ((await stat(path)).isFile()) return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    throw new Error(message, { cause: error });
  }
  throw new Error(message);
}

async function stageContentPlugin({
  glmDir,
  repoRoot,
  sourceRelative,
  stagedRelative,
  requiredPaths,
}) {
  const sourcePluginRoot = resolve(repoRoot, sourceRelative);
  const stagedPluginRoot = resolve(glmDir, stagedRelative);
  for (const relativePath of requiredPaths) {
    const sourcePath = resolve(sourcePluginRoot, ...relativePath.split("/"));
    await assertFile(
      sourcePath,
      `[stage:agent-bundle] missing official plugin asset: ${sourcePath}`,
    );
  }
  await cp(sourcePluginRoot, stagedPluginRoot, { recursive: true });
}

export function resolveAgentBundlePaths({ repoRoot, platformKey }) {
  const glmDir = resolve(repoRoot, "packages", "desktop", "bundled-agents", platformKey, "glm");
  return {
    cliBundlePath: resolve(repoRoot, AGENT_BUNDLE_SOURCE_RELATIVE),
    glmDir,
    stagedBundlePath: resolve(glmDir, "lcode.cjs"),
    stagedMetaPath: resolve(glmDir, ".node-bundle-meta.json"),
  };
}

/**
 * 干净重建 glm 目录再拷贝。清空是刻意的：electron-builder 整目录拷贝
 * bundled-agents/<平台>/glm → resources/glm，本地工作树里上一次构建残留的原生二进制
 * （lcode-agent / lcode-acp 等）和旧 meta 会被一并打进安装包（CI 干净检出不会有，本地会）。
 */
export async function stageAgentBundle({
  repoRoot,
  platformKey,
  koffiPackageRoot = resolve(repoRoot, "apps/lcode-cli/packages/adapters"),
  log = console.log,
}) {
  const { cliBundlePath, glmDir, stagedBundlePath, stagedMetaPath } = resolveAgentBundlePaths({
    repoRoot,
    platformKey,
  });
  await assertFile(
    cliBundlePath,
    `[stage:agent-bundle] agent bundle 源产物不存在：${cliBundlePath}`,
  );
  await rm(glmDir, { recursive: true, force: true });
  await mkdir(glmDir, { recursive: true });
  await copyFile(cliBundlePath, stagedBundlePath);
  // Bug 修复：dev 与 production 都会先清空 glm。只在生产打包脚本补拷 `/lemon` 会让
  // `pnpm dev:desktop` 指向一份没有命令和技能的 Agent；统一在共享 staging 点补齐。
  await stageContentPlugin({
    glmDir,
    repoRoot,
    sourceRelative: LEMON_PLUGIN_SOURCE_RELATIVE,
    stagedRelative: "packages/lemon-workflow-plugin",
    requiredPaths: LEMON_PLUGIN_REQUIRED_PATHS,
  });
  // Bug 修复：Computer Use 过去只存在于开发机用户 cache，clean checkout 的 dev bundle
  // 先清空 glm 后没有任何 seed source。与 Lemon 共用 staging owner，确保 dev/release 同源。
  await stageContentPlugin({
    glmDir,
    repoRoot,
    sourceRelative: CUA_PLUGIN_SOURCE_RELATIVE,
    stagedRelative: "packages/lcode-cua-plugin",
    requiredPaths: CUA_PLUGIN_REQUIRED_PATHS,
  });
  // 修复依据：CLI external koffi，源码树的 hoisted 依赖掩盖了安装包 MODULE_NOT_FOUND。
  // 每次清空 glm 后都由同一 staging owner 补齐，Job / getsid 不借用插件或用户缓存。
  const [os, arch] = platformKey.split("-");
  await stageKoffiIntoBundledAgents({ koffiPackageRoot, glmDir, targetPlatform: { os, arch } });
  const meta = {
    runtime: "electron-node",
    entry: "lcode.cjs",
    platform: platformKey,
    source: AGENT_BUNDLE_SOURCE_RELATIVE,
  };
  await writeFile(stagedMetaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  log(`[stage:agent-bundle] staged ${stagedBundlePath}`);
  return { stagedBundlePath, stagedMetaPath };
}
