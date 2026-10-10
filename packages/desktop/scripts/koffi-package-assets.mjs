// Agent 将 koffi 外置；Electron Node 必须从 glm 自己解析目标原生包，不能依赖源码树或 CUA cache。
import { copyFile, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const PACKAGE_FILES = ["index.js", "package.json", "index.d.ts", "LICENSE.txt"];
const SUPPORTED_TARGETS = new Set([
  "darwin_arm64",
  "darwin_x64",
  "linux_arm64",
  "linux_x64",
  "win32_arm64",
  "win32_x64",
]);

async function resolveKoffiRoot(koffiPackageRoot) {
  const manifestPath = resolve(koffiPackageRoot, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.name === "koffi") return resolve(koffiPackageRoot);
  // 修复依据：pnpm 的依赖链接位置由安装布局决定，必须从直接使用者解析，不猜 .pnpm 路径。
  return dirname(createRequire(manifestPath).resolve("koffi/package.json"));
}

function koffiPlatformKey(targetPlatform) {
  const key = `${targetPlatform?.os}_${targetPlatform?.arch}`;
  if (!SUPPORTED_TARGETS.has(key))
    throw new Error(`[koffi-package-assets] unsupported target: ${key}`);
  return key;
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return false;
  }
}

export async function stageKoffiIntoBundledAgents({ koffiPackageRoot, glmDir, targetPlatform }) {
  if (!koffiPackageRoot || !glmDir)
    throw new Error("[koffi-package-assets] koffiPackageRoot and glmDir are required");
  const sourceRoot = await resolveKoffiRoot(koffiPackageRoot);
  const platformKey = koffiPlatformKey(targetPlatform);
  const nativeRelative = `build/koffi/${platformKey}/koffi.node`;
  for (const file of [...PACKAGE_FILES, nativeRelative]) {
    if (!(await isFile(resolve(sourceRoot, file)))) {
      const kind = file === nativeRelative ? "target native addon" : "package asset";
      throw new Error(`[koffi-package-assets] missing ${kind}: ${resolve(sourceRoot, file)}`);
    }
  }
  const targetRoot = resolve(glmDir, "node_modules/koffi");
  await rm(targetRoot, { recursive: true, force: true });
  await mkdir(resolve(targetRoot, "build/koffi", platformKey), { recursive: true });
  for (const file of [...PACKAGE_FILES, nativeRelative]) {
    await copyFile(resolve(sourceRoot, file), resolve(targetRoot, file));
  }
  return resolve(targetRoot, nativeRelative);
}

export async function verifyStagedKoffi({ resourcesDir, targetPlatform }) {
  const platformKey = koffiPlatformKey(targetPlatform);
  const koffiRoot = resolve(resourcesDir, "glm/node_modules/koffi");
  const violations = [];
  for (const file of [...PACKAGE_FILES, `build/koffi/${platformKey}/koffi.node`]) {
    if (!(await isFile(resolve(koffiRoot, file)))) {
      violations.push(`missing staged Agent koffi runtime: ${resolve(koffiRoot, file)}`);
    }
  }
  try {
    for (const entry of await readdir(resolve(koffiRoot, "build/koffi"))) {
      if (entry !== platformKey) violations.push(`unexpected Agent koffi platform: ${entry}`);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return violations;
}
