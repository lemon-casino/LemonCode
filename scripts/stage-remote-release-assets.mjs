import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import {
  buildRemoteComponentDefinitions,
  buildRemoteComponentRequiredPaths,
} from "./prepare-prebuilds.mjs";
import { remoteMisePlatforms } from "./prepare-remote-mise-assets.mjs";

const unzip = promisify(gunzip);
const repoRoot = resolve(import.meta.dirname, "..");
const safeSegment = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u;

function assertVersion(version) {
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u.test(version))
    throw new Error("Invalid remote release version");
}

function resolveAsset(root, path) {
  if (
    typeof path !== "string" ||
    !path.split("/").every((part) => safeSegment.test(part) && part !== "." && part !== "..")
  )
    throw new Error(`Invalid remote artifact path: ${path}`);
  return join(root, ...path.split("/"));
}

async function readRegularFile(path, label) {
  // 发布物必须是普通文件；不跟随指向 staging 外的符号链接。
  try {
    if (!(await lstat(path)).isFile()) throw new Error("not a regular file");
    const bytes = await readFile(path);
    if (!bytes.length) throw new Error("empty file");
    return bytes;
  } catch (error) {
    throw new Error(`Invalid remote ${label}: ${path}`, { cause: error });
  }
}

async function verifyArchive(path, component, platform) {
  const bytes = await readRegularFile(path, "archive");
  if (createHash("sha256").update(bytes).digest("hex") !== component.sha256)
    throw new Error(`Remote archive SHA mismatch: ${platform}/${component.id}`);
  const tar = await unzip(bytes);
  const members = new Set();
  for (let offset = 0; offset < tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.length !== 512) throw new Error(`Truncated remote archive: ${path}`);
    if (header.every((byte) => byte === 0)) break;
    const text = (start, end) =>
      header.subarray(start, end).toString("utf8").replace(/\0.*$/su, "");
    const name = [text(345, 500), text(0, 100)].filter(Boolean).join("/").replace(/\/$/u, "");
    if (
      !name ||
      name.startsWith("/") ||
      name.includes("\\") ||
      /^[A-Za-z]:/u.test(name) ||
      name.split("/").includes("..")
    )
      throw new Error(`Invalid remote archive member path: ${name}`);
    const size = Number.parseInt(text(124, 136).trim(), 8);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length)
      throw new Error(`Invalid remote archive member: ${name}`);
    if ((header[156] === 0 || header[156] === 48) && size > 0) members.add(name);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  for (const member of buildRemoteComponentRequiredPaths(component.id, platform)) {
    if (!members.has(member))
      throw new Error(
        `Remote archive missing required member: ${platform}/${component.id}/${member}`,
      );
  }
}

async function readReleaseManifest({ version, platform, manifestPath, artifactRoot, flat }) {
  const manifest = JSON.parse((await readRegularFile(manifestPath, "manifest")).toString("utf8"));
  if (manifest.schemaVersion !== 1) throw new Error(`Invalid remote manifest schema: ${platform}`);
  if (manifest.appVersion !== version)
    throw new Error(`Remote manifest version mismatch: ${platform}`);
  if (manifest.platformArch !== platform)
    throw new Error(`Remote manifest platform mismatch: ${platform}`);
  if (!Array.isArray(manifest.components))
    throw new Error(`Invalid remote manifest components: ${platform}`);
  const definitions = new Map(
    buildRemoteComponentDefinitions(platform).map((definition) => [definition.id, definition]),
  );
  const seen = new Set();
  for (const component of manifest.components) {
    const definition = definitions.get(component?.id);
    if (!definition) throw new Error(`Unknown remote component: ${platform}/${component?.id}`);
    if (seen.has(component.id))
      throw new Error(`Duplicate remote component: ${platform}/${component.id}`);
    seen.add(component.id);
    if (typeof component.version !== "string" || !safeSegment.test(component.version))
      throw new Error(`Invalid remote component version: ${platform}/${component.id}`);
    if (component.mount !== definition.mount)
      throw new Error(`Remote component mount mismatch: ${platform}/${component.id}`);
    if (typeof component.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(component.sha256))
      throw new Error(`Invalid remote component SHA: ${platform}/${component.id}`);
    const path = resolveAsset(artifactRoot, component.artifactPath);
    if (flat && component.artifactPath !== releaseArchiveName(platform, component))
      throw new Error(`Invalid flat remote artifact path: ${component.artifactPath}`);
    await verifyArchive(path, component, platform);
  }
  const missing = [...definitions.keys()].filter((id) => !seen.has(id));
  if (missing.length)
    throw new Error(`Remote manifest missing components: ${platform}: ${missing.join(", ")}`);
  return manifest;
}

function releaseArchiveName(platform, component) {
  return `remote-${platform}-${component.id}-${component.sha256}.tar.gz`;
}

export async function verifyRemoteReleaseAssets({ version, directory }) {
  assertVersion(version);
  const names = [];
  for (const platform of remoteMisePlatforms) {
    const manifestName = `manifest-${platform}.json`;
    const manifest = await readReleaseManifest({
      version,
      platform,
      manifestPath: join(directory, manifestName),
      artifactRoot: directory,
      flat: true,
    });
    names.push(manifestName, ...manifest.components.map((component) => component.artifactPath));
  }
  return names;
}

export async function stageRemoteReleaseAssets({ version, sourceDir, outputDir }) {
  assertVersion(version);
  const destination = resolve(outputDir);
  const source = resolve(sourceDir);
  const sourceRelative = relative(destination, source);
  if (
    destination === dirname(destination) ||
    !sourceRelative ||
    (!sourceRelative.startsWith(`..${sep}`) && !isAbsolute(sourceRelative))
  )
    throw new Error("Remote output path must not contain the source directory");
  // 修复：先校验所有目标，再写完整 staging；不能留下可被上传的半份 manifest。
  const manifests = [];
  for (const platform of remoteMisePlatforms) {
    manifests.push(
      await readReleaseManifest({
        version,
        platform,
        manifestPath: join(source, "releases", version, `manifest-${platform}.json`),
        artifactRoot: source,
        flat: false,
      }),
    );
  }
  await mkdir(dirname(destination), { recursive: true });
  const staging = await mkdtemp(`${destination}.staging-`);
  try {
    for (const manifest of manifests) {
      const components = [];
      for (const component of manifest.components) {
        const artifactPath = releaseArchiveName(manifest.platformArch, component);
        await copyFile(resolveAsset(source, component.artifactPath), join(staging, artifactPath));
        components.push({ ...component, artifactPath });
      }
      await writeFile(
        join(staging, `manifest-${manifest.platformArch}.json`),
        `${JSON.stringify({ ...manifest, components }, null, 2)}\n`,
      );
    }
    const names = await verifyRemoteReleaseAssets({ version, directory: staging });
    // destination 已解析并排除了盘根及源目录的祖先；只替换此入口独占的生成目录。
    await rm(destination, { recursive: true, force: true });
    await rename(staging, destination);
    return names;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function main() {
  const [action = "stage", directory] = process.argv.slice(2);
  const { version } = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
  if (action === "--verify-collected") {
    const names = await verifyRemoteReleaseAssets({
      version,
      directory: resolve(directory ?? "release-assets"),
    });
    console.log(`Verified ${names.length} remote release assets for ${version}`);
  } else if (action === "stage") {
    const names = await stageRemoteReleaseAssets({
      version,
      sourceDir: join(repoRoot, "packages/desktop/mock-cdn"),
      outputDir: join(repoRoot, "packages/desktop/dist/remote-release-assets"),
    });
    console.log(`Staged ${names.length} remote release assets for ${version}`);
  } else
    throw new Error(
      "Usage: stage-remote-release-assets.mjs [stage | --verify-collected [directory]]",
    );
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  await main();
