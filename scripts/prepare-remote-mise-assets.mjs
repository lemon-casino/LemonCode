import { chmod, copyFile, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  loadBackendArchiveApi,
  prepareMiseRuntimeAssets,
  resolveMiseTarget,
} from "../packages/desktop/scripts/prepare-mise-runtime-assets.mjs";
import { validateMiseBuildProvenance } from "./mise-build-provenance.mjs";

const workspaceRoot = resolve(import.meta.dirname, "..");
export const remoteMisePlatforms = ["linux-arm64", "linux-x64", "darwin-arm64", "darwin-x64"];
const defaultToolsRoot = join(workspaceRoot, "packages/desktop/mock-cdn/releases");

export function resolveRemoteMiseTarget(platformKey) {
  if (!remoteMisePlatforms.includes(platformKey))
    throw new Error(`Unsupported remote mise target: ${platformKey}`);
  const [os, arch] = platformKey.split("-");
  // remote 当前发行只支持 glibc；不能受构建机/桌面的 LCODE_MISE_LIBC 覆盖，产出同 key 的异构包。
  return resolveMiseTarget({ os, arch, libc: os === "linux" ? "glibc" : "" });
}

export async function validateRemoteMiseRuntimeAssets({ root, target, cacheDir, backendApi }) {
  const api = backendApi ?? (await loadBackendArchiveApi());
  const result = await api.validateBundledBackend(root, {
    platform: target.backendPlatform,
    version: api.MISE_BACKEND_VERSION,
    archiveSha256: api.MISE_ASSET_DIGESTS[target.backendKey],
  });
  await validateMiseBuildProvenance({ root, target, backendApi: api, cacheDir });
  return { ...result, root, target };
}

async function stageMiseRuntime({
  root,
  target,
  desktopRoot,
  cacheDir,
  backendApi,
  skip = process.env.LCODE_SKIP_MISE_PREPARE === "1",
}) {
  const api = backendApi ?? (await loadBackendArchiveApi());
  const options = { root, target, cacheDir, backendApi: api };
  // 修复：skip 不能通过重建/复制补足资产，更不能把缺 mise 的旧 remote runtime 当成成功。
  if (skip) return validateRemoteMiseRuntimeAssets(options);
  const source = await prepareMiseRuntimeAssets({
    desktopRoot,
    target,
    cacheDir,
    backendApi: api,
    skip: false,
  });
  await mkdir(dirname(root), { recursive: true });
  const staging = await mkdtemp(join(dirname(root), ".mise-stage-"));
  try {
    for (const relative of [
      ...api
        .requiredBackendMembers(target.backendPlatform)
        .map((member) => member.slice("mise/".length)),
      "backend-manifest.json",
    ]) {
      const destination = join(staging, relative);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(join(source.root, relative), destination);
      if (relative.startsWith("bin/")) await chmod(destination, 0o755);
    }
    await validateRemoteMiseRuntimeAssets({ ...options, root: staging });
    await rm(root, { recursive: true, force: true });
    await rename(staging, root);
    return validateRemoteMiseRuntimeAssets(options);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function prepareRemoteMiseRuntimeAssets({ platformKey, outputDir, ...options }) {
  if (!outputDir) throw new Error("outputDir is required for remote mise assets");
  const target = resolveRemoteMiseTarget(platformKey);
  return stageMiseRuntime({ ...options, target, root: resolve(outputDir, platformKey, "mise") });
}

export async function stageServerMiseRuntimeAssets({ runtimeRoot, ...options }) {
  if (!runtimeRoot) throw new Error("runtimeRoot is required for server mise assets");
  const target = options.target ?? resolveMiseTarget();
  return stageMiseRuntime({ ...options, target, root: resolve(runtimeRoot, "tools", "mise") });
}

const entryHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entryHref === import.meta.url) {
  const { readFile } = await import("node:fs/promises");
  const { version } = JSON.parse(await readFile(join(workspaceRoot, "package.json"), "utf8"));
  const argv = process.argv.slice(2);
  const skip = argv.includes("--skip") || process.env.LCODE_SKIP_MISE_PREPARE === "1";
  const platforms = argv.filter((arg) => arg !== "--skip");
  for (const platformKey of platforms.length ? platforms : remoteMisePlatforms) {
    const result = await prepareRemoteMiseRuntimeAssets({
      platformKey,
      outputDir: join(defaultToolsRoot, version, "tools"),
      skip,
    });
    console.log(`[prepare:remote-mise] ${platformKey} -> ${result.backendPath}`);
  }
}
