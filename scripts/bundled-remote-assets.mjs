import { join, resolve } from "node:path";
import {
  stageRemoteReleaseAssets,
  verifyRemoteReleaseAssets,
} from "./stage-remote-release-assets.mjs";

export function bundleRemoteAssetsEnabled(env = process.env) {
  const value = env.LCODE_BUNDLE_REMOTE_ASSETS;
  // 修复：普通安装包无需附带四平台资源；未发布/离线包由用户显式选择内置模式。
  if (value === undefined || value === "0") return false;
  if (value === "1") return true;
  throw new Error("Invalid LCODE_BUNDLE_REMOTE_ASSETS: expected 0 or 1");
}

export async function prepareBundledRemoteAssets({
  repoRoot = resolve(import.meta.dirname, ".."),
  version,
  sourceDir = join(repoRoot, "packages/desktop/mock-cdn"),
  outputDir = join(repoRoot, "packages/desktop/dist/remote-release-assets"),
  skipPrepare = false,
  run,
}) {
  // 修复：本地未发布版本不能依赖 GitHub 的同版本资源；只用既有 producer / staging owner。
  if (skipPrepare) return verifyRemoteReleaseAssets({ version, directory: outputDir });
  await run("pnpm", ["prepare:remote-assets"], { cwd: repoRoot });
  return stageRemoteReleaseAssets({ version, sourceDir, outputDir });
}
