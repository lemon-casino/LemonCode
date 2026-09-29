import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(import.meta.dirname, "..");
const formats = {
  mac: ["dmg", "zip"],
  win: ["exe"],
  linux: ["AppImage", "deb", "rpm", "pkg.tar.zst"],
};
const architectures = ["x64", "arm64"];
// electron-builder 的 Linux 安装格式使用不同的原生架构后缀；按实际产物匹配，避免误判缺包。
const linuxPackageArchitectures = {
  x64: { AppImage: "x86_64", deb: "amd64", rpm: "x86_64", "pkg.tar.zst": "x64" },
  arm64: { AppImage: "arm64", deb: "arm64", rpm: "aarch64", "pkg.tar.zst": "aarch64" },
};
// electron-builder 在 dist 生成的更新清单（内含安装包 sha512）是应用内更新服务的唯一
// 校验和来源；按 latest-<os>-<arch>.yml 重命名收集，供 cfworker-remote 清单服务代理。
const updateManifests = {
  mac: "latest-mac.yml",
  win: "latest.yml",
  linux: "latest-linux.yml",
};

export function expectedArtifactNames(version, os, arch) {
  if (!formats[os] || !architectures.includes(arch)) {
    throw new Error(`Unsupported desktop target: ${os}-${arch}`);
  }
  const installers = formats[os].map((extension) => {
    const artifactArch = os === "linux" ? linuxPackageArchitectures[arch][extension] : arch;
    return `LCode-${version}-${os}-${artifactArch}.${extension}`;
  });
  return [...installers, `latest-${os}-${arch}.yml`];
}

async function assertNonemptyFile(directory, name) {
  const file = await stat(resolve(directory, name)).catch(() => null);
  if (!file?.isFile() || file.size === 0) {
    throw new Error(`Missing or empty release artifact: ${name}`);
  }
}

export async function stageReleaseArtifacts({ version, os, arch, distDir, outputDir }) {
  const names = expectedArtifactNames(version, os, arch);
  const installers = names.slice(0, -1);
  // dist 里的清单源文件名固定为 electron-builder 的 latest*.yml，落盘时重命名为
  // latest-<os>-<arch>.yml（同一 OS 的 x64/arm64 构建各产出一份 latest.yml，按架构区分）。
  const manifestSource = updateManifests[os];
  const manifestTarget = names[names.length - 1];
  for (const name of installers) await assertNonemptyFile(distDir, name);
  await assertNonemptyFile(distDir, manifestSource);
  await mkdir(outputDir, { recursive: true });
  for (const name of installers) {
    await copyFile(resolve(distDir, name), resolve(outputDir, name));
  }
  await copyFile(resolve(distDir, manifestSource), resolve(outputDir, manifestTarget));
  return names;
}

export async function verifyCollectedArtifacts({ version, directory }) {
  const expected = Object.keys(formats).flatMap((os) =>
    architectures.flatMap((arch) => expectedArtifactNames(version, os, arch)),
  );
  const actual = await readdir(directory);
  const missing = expected.filter((name) => !actual.includes(name));
  const extra = actual.filter((name) => !expected.includes(name));
  if (missing.length || extra.length) {
    throw new Error(
      `Invalid release assets: missing [${missing.join(", ")}], extra [${extra.join(", ")}]`,
    );
  }
  for (const name of expected) await assertNonemptyFile(directory, name);
  return expected;
}

async function main() {
  const [version, os, arch] = process.argv.slice(2);
  if (!version)
    throw new Error(
      "Usage: stage-release-artifacts.mjs <version> <os> <arch> | <version> --verify-collected",
    );
  if (os === "--verify-collected") {
    const names = await verifyCollectedArtifacts({
      version,
      directory: resolve(repoRoot, "release-assets"),
    });
    console.log(`Verified ${names.length} release assets for ${version}`);
    return;
  }
  const names = await stageReleaseArtifacts({
    version,
    os,
    arch,
    distDir: resolve(repoRoot, "packages/desktop/dist"),
    outputDir: resolve(repoRoot, "packages/desktop/dist/release-assets"),
  });
  console.log(`Staged ${os}-${arch}: ${names.join(", ")}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
