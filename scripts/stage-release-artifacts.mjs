import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { posix, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

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
// electron-builder 在 dist 生成的更新清单提供 release notes 等元数据；staging 才是最终
// size/sha512 的唯一所有者，确保仓库外内签只要发生在 staging 前就不会留下陈旧摘要。
// 清单按 latest-<os>-<arch>.yml 收集，供 cfworker-remote 更新服务代理。
// 已知上游行为（v3.16.2 CI 实证）：electron-builder 只为 Linux x64 生成 latest-linux.yml。
// arm64 不能因此退回手动更新，缺少上游清单时由 staging 从已校验产物确定性生成。
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

async function sha512Base64(path) {
  const hash = createHash("sha512");
  await pipeline(createReadStream(path), hash);
  return hash.digest("base64");
}

async function readInstallerMetadata(distDir, installerNames) {
  return Promise.all(
    installerNames.map(async (name) => {
      const path = resolve(distDir, name);
      const [file, sha512] = await Promise.all([stat(path), sha512Base64(path)]);
      return { url: name, sha512, size: file.size, mtimeMs: file.mtimeMs };
    }),
  );
}

function buildUpdateManifest({ version, files, primaryName, releaseDate, source = {} }) {
  const primary = files.find(({ url }) => url === primaryName);
  if (!primary) throw new Error(`Missing primary update artifact: ${primaryName}`);
  const sourceFilesByName = new Map(
    Array.isArray(source.files)
      ? source.files.map((file) => [
          typeof file?.url === "string" ? posix.basename(file.url.replaceAll("\\", "/")) : "",
          file,
        ])
      : [],
  );
  const refreshedFiles = files.map(({ mtimeMs: _mtimeMs, ...file }) => {
    const sourceFile = sourceFilesByName.get(file.url) ?? {};
    const sourceMatchesFinalBytes =
      sourceFile.sha512 === file.sha512 && sourceFile.size === file.size;
    const { blockMapSize: _staleBlockMapSize, ...sourceWithoutBlockMapSize } = sourceFile;
    return {
      ...(sourceMatchesFinalBytes ? sourceFile : sourceWithoutBlockMapSize),
      ...file,
    };
  });
  return YAML.stringify({
    ...source,
    version,
    files: refreshedFiles,
    path: primary.url,
    sha512: primary.sha512,
    releaseDate:
      releaseDate ?? new Date(Math.max(...files.map(({ mtimeMs }) => mtimeMs))).toISOString(),
  });
}

export async function createLinuxUpdateManifest({ version, arch, distDir, releaseDate }) {
  if (!architectures.includes(arch)) {
    throw new Error(`Unsupported Linux update architecture: ${arch}`);
  }
  const manifestName = `latest-linux-${arch}.yml`;
  const installerNames = expectedArtifactNames(version, "linux", arch).filter(
    (name) => name !== manifestName,
  );
  return buildUpdateManifest({
    version,
    files: await readInstallerMetadata(distDir, installerNames),
    primaryName: installerNames.find((name) => name.endsWith(".AppImage")),
    releaseDate,
  });
}

async function readManifestForInstallers(path, version, installerNames) {
  try {
    const manifest = YAML.parse(await readFile(path, "utf8"));
    if (manifest?.version !== version || !Array.isArray(manifest.files)) return null;
    const actualNames = manifest.files
      .map(({ url }) => (typeof url === "string" ? posix.basename(url.replaceAll("\\", "/")) : ""))
      .filter(Boolean)
      .toSorted();
    return JSON.stringify(actualNames) === JSON.stringify(installerNames.toSorted())
      ? manifest
      : null;
  } catch {
    return null;
  }
}

async function refreshUpdateManifest({ source, version, os, distDir, installerNames }) {
  const primaryName =
    os === "mac"
      ? installerNames.find((name) => name.endsWith(".zip"))
      : os === "linux"
        ? installerNames.find((name) => name.endsWith(".AppImage"))
        : installerNames[0];
  return buildUpdateManifest({
    source,
    version,
    files: await readInstallerMetadata(distDir, installerNames),
    primaryName,
  });
}

async function assertNonemptyFile(directory, name) {
  const file = await stat(resolve(directory, name)).catch(() => null);
  if (!file?.isFile() || file.size === 0) {
    throw new Error(`Missing or empty release artifact: ${name}`);
  }
}

export async function stageReleaseArtifacts({ version, os, arch, distDir, outputDir }) {
  const names = expectedArtifactNames(version, os, arch);
  const manifestSource = updateManifests[os];
  const manifestTarget = `latest-${os}-${arch}.yml`;
  // 安装包先校验（缺失是主错误）；清单源文件名固定为 electron-builder 的 latest*.yml，
  // 落盘时重命名为 latest-<os>-<arch>.yml（同一 OS 的 x64/arm64 构建各产出一份，按架构区分）。
  // 已知上游例外：Linux arm64 构建不产出清单。该目标缺席时必须生成，不能让
  // Worker 对 linux-aarch64 返回 404；校验和直接读取当前 job 的最终安装包字节。
  const installers = names.filter((name) => name !== manifestTarget);
  for (const name of installers) await assertNonemptyFile(distDir, name);
  const manifestSourcePath = resolve(distDir, manifestSource);
  const manifestSourceFile = await stat(manifestSourcePath).catch(() => null);
  const hasManifestSource = Boolean(manifestSourceFile?.isFile() && manifestSourceFile.size > 0);
  if (!hasManifestSource && manifestTarget !== "latest-linux-arm64.yml") {
    throw new Error(`Missing or empty release artifact: ${manifestSource}`);
  }
  await mkdir(outputDir, { recursive: true });
  for (const name of installers) {
    await copyFile(resolve(distDir, name), resolve(outputDir, name));
  }
  const sourceManifest = hasManifestSource
    ? await readManifestForInstallers(manifestSourcePath, version, installers)
    : null;
  if (sourceManifest) {
    // 内签或其它打包后处理会改变文件字节；不能照抄 electron-builder 的旧摘要。
    // staging 以最终安装包重新计算 size/sha512，同时保留上游 release notes 等扩展字段。
    await writeFile(
      resolve(outputDir, manifestTarget),
      await refreshUpdateManifest({
        source: sourceManifest,
        version,
        os,
        distDir,
        installerNames: installers,
      }),
      "utf8",
    );
  } else {
    if (manifestTarget !== "latest-linux-arm64.yml") {
      throw new Error(`Invalid update manifest for ${os}-${arch}: ${manifestSource}`);
    }
    // 功能原因：本地连续构建可能残留 x64 的 latest-linux.yml，不能把存在性误当成
    // arm64 身份。只有清单中的版本和四个原生包名都匹配时才复用，否则从 arm64 产物重算。
    await writeFile(
      resolve(outputDir, manifestTarget),
      await createLinuxUpdateManifest({ version, arch, distDir }),
      "utf8",
    );
  }
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
