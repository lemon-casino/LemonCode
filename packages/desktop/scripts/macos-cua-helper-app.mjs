/* eslint-disable max-lines -- SEA build, bundle staging and integrity manifest share one release boundary. */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import {
  collectWindowsCuaRuntimeManifestFiles,
  requireCanonicalWindowsRuntimePath,
} from "./windows-cua-runtime-manifest.mjs";
import { stageCuaRuntimeTree } from "./windows-cua-runtime-assets.mjs";

export const MAC_CUA_HELPER_APP_NAME = "ZCode Computer Use.app";
export const MAC_CUA_HELPER_DISPLAY_NAME = "ZCode Computer Use";
export const MAC_CUA_HELPER_BUNDLE_ID = "dev.zcode.cua-helper";
export const MAC_CUA_HELPER_EXECUTABLE_NAME = "ZCode Computer Use";
export const MAC_CUA_PIP_PRESENTER_EXECUTABLE_NAME = "ZCode Computer Use PiP";
export const MAC_CUA_PIP_PRESENTER_ENV = "ZCODE_CUA_PIP_PRESENTER";
export const MAC_CUA_NODE_EXECUTABLE_ENV = "ZCODE_CUA_MAC_NODE_EXECUTABLE";
export const MAC_CUA_NODE_VERSION_ENV = "ZCODE_CUA_MAC_NODE_VERSION";
export const MAC_CUA_NODE_SHA256_ENV = "ZCODE_CUA_MAC_NODE_SHA256";

const execFileAsync = promisify(execFile);
const requireFromScript = createRequire(import.meta.url);
const MANIFEST_RELATIVE_PATH = "Contents/Resources/runtime-manifest.json";
const EXECUTABLE_RELATIVE_PATH = `Contents/MacOS/${MAC_CUA_HELPER_EXECUTABLE_NAME}`;
const PIP_PRESENTER_RELATIVE_PATH = `Contents/MacOS/${MAC_CUA_PIP_PRESENTER_EXECUTABLE_NAME}`;
const RUNTIME_RELATIVE_PATH = "Contents/Resources/runtime";
const INFO_PLIST_RELATIVE_PATH = "Contents/Info.plist";
const PIP_PRESENTER_SOURCE_PATH = resolve(
  import.meta.dirname,
  "../native/macos-cua-pip-presenter/main.swift",
);
const PIP_PRESENTER_TARGET_TRIPLES = Object.freeze({
  arm64: "arm64-apple-macos12.0",
  x64: "x86_64-apple-macos12.0",
});

function isNonEmptyTrimmedString(value) {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function normalizeArchitecture(value) {
  switch (
    String(value ?? "")
      .trim()
      .toLowerCase()
  ) {
    case "amd64":
    case "x86_64":
    case "x64":
      return "x64";
    case "aarch64":
    case "arm64":
      return "arm64";
    default:
      return String(value ?? "")
        .trim()
        .toLowerCase();
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function escapePlistString(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function createMacCuaBuildVersion(buildIdentity) {
  if (!isNonEmptyTrimmedString(buildIdentity)) {
    throw new Error("[macos-cua-helper-app] Helper build identity must be non-empty");
  }
  const digest = createHash("sha256").update(buildIdentity).digest();
  return [0, 2, 4].map((offset) => String((digest.readUInt16BE(offset) % 65_535) + 1)).join(".");
}

export function createMacCuaInfoPlist(appVersion, buildVersion) {
  if (!/^\d+(?:\.\d+){0,3}$/u.test(appVersion)) {
    throw new Error("[macos-cua-helper-app] app version is not valid for Info.plist");
  }
  if (!/^\d+(?:\.\d+){0,2}$/u.test(buildVersion)) {
    throw new Error("[macos-cua-helper-app] build version is not valid for Info.plist");
  }
  const marketingVersion = escapePlistString(appVersion);
  const bundleVersion = escapePlistString(buildVersion);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>${MAC_CUA_HELPER_DISPLAY_NAME}</string>
  <key>CFBundleExecutable</key>
  <string>${MAC_CUA_HELPER_EXECUTABLE_NAME}</string>
  <key>CFBundleIdentifier</key>
  <string>${MAC_CUA_HELPER_BUNDLE_ID}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>${MAC_CUA_HELPER_DISPLAY_NAME}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${marketingVersion}</string>
  <key>CFBundleVersion</key>
  <string>${bundleVersion}</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
`;
}

export function createMacCuaSeaBootstrapSource() {
  // SEA 只负责建立可信文件边界；业务协议与权限逻辑仍由仓内同一 helper-entry.js 拥有。
  return `"use strict";
const { createHash } = require("node:crypto");
const { lstatSync, readFileSync, readdirSync, realpathSync } = require("node:fs");
const { dirname, relative, resolve, sep } = require("node:path");
const { pathToFileURL } = require("node:url");

const bundleRoot = resolve(dirname(process.execPath), "../..");
const manifestPath = resolve(bundleRoot, ${JSON.stringify(MANIFEST_RELATIVE_PATH)});
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const expectedExecutable = ${JSON.stringify(EXECUTABLE_RELATIVE_PATH)};
const expectedPresenter = ${JSON.stringify(PIP_PRESENTER_RELATIVE_PATH)};
const expectedRuntimePrefix = ${JSON.stringify(`${RUNTIME_RELATIVE_PATH}/`)};
const expectedInfoPlist = ${JSON.stringify(INFO_PLIST_RELATIVE_PATH)};

function fail(message) { throw new Error("Computer Use Helper integrity check failed: " + message); }
function hash(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function canonical(path) {
  if (typeof path !== "string" || !path || path.includes("\\\\") || path.startsWith("/") || path.includes("\\0")) fail("invalid manifest path");
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) fail("invalid manifest path");
  return path;
}
function walk(directory, prefix) {
  const rows = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const relativePath = prefix + "/" + entry.name;
    const absolutePath = resolve(directory, entry.name);
    const stats = lstatSync(absolutePath);
    if (stats.isSymbolicLink()) fail("runtime contains a symlink");
    if (entry.isDirectory()) rows.push(...walk(absolutePath, relativePath));
    else if (entry.isFile()) rows.push(relativePath);
    else fail("runtime contains a non-file entry");
  }
  return rows;
}
if (manifest.schemaVersion !== 1 || manifest.bundleId !== ${JSON.stringify(MAC_CUA_HELPER_BUNDLE_ID)} || manifest.executable !== expectedExecutable || manifest.presenter !== expectedPresenter) fail("invalid manifest identity");
if (!Array.isArray(manifest.files) || !Array.isArray(manifest.signedMutablePaths)) fail("invalid manifest files");
const mutable = new Set(manifest.signedMutablePaths.map(canonical));
if (!mutable.has(expectedExecutable) || !mutable.has(expectedPresenter) || [...mutable].some((path) => path !== expectedExecutable && path !== expectedPresenter && !(path.startsWith(expectedRuntimePrefix) && path.endsWith(".node")))) fail("invalid signed mutable paths");
const expected = new Map();
for (const file of manifest.files) {
  const path = canonical(file && file.path);
  if (expected.has(path) || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)) fail("invalid manifest entry");
  expected.set(path, file.sha256);
}
if (!expected.has(expectedInfoPlist) || !expected.has(expectedExecutable) || !expected.has(expectedPresenter)) fail("incomplete manifest");
if ([...mutable].some((path) => !expected.has(path))) fail("mutable path is missing from manifest");
const presenterPath = resolve(bundleRoot, ...expectedPresenter.split("/"));
let presenterStats;
try { presenterStats = lstatSync(presenterPath); } catch { fail("invalid presenter executable"); }
if (!presenterStats.isFile() || presenterStats.isSymbolicLink()) fail("invalid presenter executable");
const runtimeRoot = resolve(bundleRoot, ${JSON.stringify(RUNTIME_RELATIVE_PATH)});
const physicalRuntime = realpathSync(runtimeRoot);
const physicalBundle = realpathSync(bundleRoot);
const runtimeRelative = relative(physicalBundle, physicalRuntime);
if (!runtimeRelative || runtimeRelative === ".." || runtimeRelative.startsWith(".." + sep)) fail("runtime escapes bundle");
const actualRuntimeFiles = walk(runtimeRoot, ${JSON.stringify(RUNTIME_RELATIVE_PATH)}).sort();
const expectedRuntimeFiles = [...expected.keys()].filter((path) => path.startsWith(expectedRuntimePrefix)).sort();
if (JSON.stringify(actualRuntimeFiles) !== JSON.stringify(expectedRuntimeFiles)) fail("runtime file set changed");
for (const [path, digest] of expected) {
  if (mutable.has(path)) continue;
  if (hash(resolve(bundleRoot, ...path.split("/"))) !== digest) fail("hash mismatch for " + path);
}
process.env.ZCODE_CUA_HELPER_ADDON = resolve(runtimeRoot, "xa11y-native-loader.js");
process.env[${JSON.stringify(MAC_CUA_PIP_PRESENTER_ENV)}] = presenterPath;
const firstFlag = process.argv.findIndex((value, index) => index > 0 && value.startsWith("--"));
const helperArgs = firstFlag < 0 ? [] : process.argv.slice(firstFlag);
import(pathToFileURL(resolve(runtimeRoot, manifest.entry)).href)
  .then((module) => module.runHelperProcess({ args: module.parseHelperArguments(helperArgs) }))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
`;
}

async function defaultReadExecutableArchs(executablePath) {
  if (process.platform !== "darwin") {
    throw new Error(
      "[macos-cua-helper-app] Mach-O architecture validation requires macOS or an injected inspector",
    );
  }
  const { stdout } = await execFileAsync("/usr/bin/lipo", ["-archs", executablePath], {
    encoding: "utf8",
  });
  return stdout.trim().split(/\s+/u).filter(Boolean);
}

async function requirePipPresenterSource() {
  const stats = await lstat(PIP_PRESENTER_SOURCE_PATH);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error("[macos-cua-helper-app] PiP presenter source must be a regular file");
  }
  return await realpath(PIP_PRESENTER_SOURCE_PATH);
}

async function defaultCompilePipPresenter({ sourcePath, targetPath, targetTriple }) {
  try {
    await execFileAsync(
      "xcrun",
      [
        "--sdk",
        "macosx",
        "swiftc",
        "-O",
        "-whole-module-optimization",
        "-target",
        targetTriple,
        sourcePath,
        "-o",
        targetPath,
        "-framework",
        "AppKit",
      ],
      { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
    );
  } catch (error) {
    throw new Error("[macos-cua-helper-app] failed to compile the macOS PiP presenter", {
      cause: error,
    });
  }
}

async function requireCompiledPipPresenter({ presenterPath, targetArch, readExecutableArchs }) {
  let stats;
  try {
    stats = await lstat(presenterPath);
  } catch {
    throw new Error("[macos-cua-helper-app] compiled PiP presenter is missing");
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error("[macos-cua-helper-app] compiled PiP presenter must be a regular file");
  }
  const archs = [
    ...new Set(
      (await readExecutableArchs(await realpath(presenterPath))).map(normalizeArchitecture),
    ),
  ];
  if (archs.length !== 1 || archs[0] !== targetArch) {
    throw new Error(
      `[macos-cua-helper-app] compiled PiP presenter must contain only ${targetArch}`,
    );
  }
}

async function findSeaFuse(executablePath) {
  const contents = await readFile(executablePath, "latin1");
  const match = contents.match(/NODE_SEA_FUSE_[a-z0-9]+:0/iu);
  if (!match) {
    throw new Error("[macos-cua-helper-app] configured Node executable has no SEA fuse");
  }
  return match[0].replace(/:0$/u, "");
}

async function removeMacCodeSignature(executablePath) {
  try {
    await execFileAsync("/usr/bin/codesign", ["--remove-signature", executablePath]);
  } catch (error) {
    const output = [
      error instanceof Error ? error.message : String(error),
      error?.stdout,
      error?.stderr,
    ]
      .filter(Boolean)
      .join("\n");
    if (/code object is not signed at all/iu.test(output)) return;
    throw new Error("[macos-cua-helper-app] failed to remove the source Node signature", {
      cause: error,
    });
  }
}

async function defaultPrepareSeaExecutable({ sourceNodePath, targetPath, bootstrapSource }) {
  const buildRoot = resolve(tmpdir(), `.zcode-cua-mac-sea-${process.pid}-${randomUUID()}`);
  await mkdir(buildRoot, { recursive: true });
  try {
    const bootstrapPath = resolve(buildRoot, "bootstrap.cjs");
    const blobPath = resolve(buildRoot, "helper.sea.blob");
    const configPath = resolve(buildRoot, "sea-config.json");
    await writeFile(bootstrapPath, bootstrapSource, "utf8");
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          main: bootstrapPath,
          output: blobPath,
          disableExperimentalSEAWarning: true,
          useCodeCache: false,
          useSnapshot: false,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await execFileAsync(process.execPath, ["--experimental-sea-config", configPath]);
    await copyFile(sourceNodePath, targetPath);
    await chmod(targetPath, 0o755);
    // 根因：官方 Node 的原签名覆盖被 postject 修改的 Mach-O；不先移除会留下必然失效的
    // CodeDirectory。这里只处理 staging 副本，正式 Developer ID 签名仍由 electron-builder 负责。
    if (process.platform === "darwin") {
      await removeMacCodeSignature(targetPath);
    }
    const sentinelFuse = await findSeaFuse(targetPath);
    const { inject } = requireFromScript("postject");
    await inject(targetPath, "NODE_SEA_BLOB", await readFile(blobPath), {
      machoSegmentName: "NODE_SEA",
      sentinelFuse,
    });
  } finally {
    await rm(buildRoot, { recursive: true, force: true });
  }
}

async function requireNodeBuildInput({
  nodeExecutablePath,
  nodeVersion,
  nodeSha256,
  targetArch,
  readExecutableArchs,
}) {
  if (!isNonEmptyTrimmedString(nodeExecutablePath) || !isAbsolute(nodeExecutablePath)) {
    throw new Error(
      `[macos-cua-helper-app] ${MAC_CUA_NODE_EXECUTABLE_ENV} must be an absolute path`,
    );
  }
  if (
    !isNonEmptyTrimmedString(nodeVersion) ||
    nodeVersion.replace(/^v/u, "") !== process.versions.node
  ) {
    throw new Error(
      `[macos-cua-helper-app] ${MAC_CUA_NODE_VERSION_ENV} must match the build Node version ${process.versions.node}`,
    );
  }
  if (typeof nodeSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(nodeSha256)) {
    throw new Error(
      `[macos-cua-helper-app] ${MAC_CUA_NODE_SHA256_ENV} must be a lowercase SHA-256`,
    );
  }
  const sourcePath = resolve(nodeExecutablePath);
  const sourceStats = await lstat(sourcePath);
  if (!sourceStats.isFile() || sourceStats.isSymbolicLink()) {
    throw new Error("[macos-cua-helper-app] configured Node executable must be a regular file");
  }
  const physicalPath = await realpath(sourcePath);
  const bytes = await readFile(physicalPath);
  if (sha256(bytes) !== nodeSha256) {
    throw new Error("[macos-cua-helper-app] configured Node executable SHA-256 mismatch");
  }
  const archs = (await readExecutableArchs(physicalPath)).map(normalizeArchitecture);
  if (!archs.includes(targetArch)) {
    throw new Error(
      `[macos-cua-helper-app] configured Node executable does not contain ${targetArch}`,
    );
  }
  return physicalPath;
}

function requireMacTarget(targetPlatform) {
  if (
    targetPlatform?.os !== "darwin" ||
    (targetPlatform.arch !== "x64" && targetPlatform.arch !== "arm64") ||
    targetPlatform.key !== `darwin-${targetPlatform.arch}`
  ) {
    throw new Error(
      `[macos-cua-helper-app] unsupported macOS target: ${String(targetPlatform?.key)}`,
    );
  }
  return targetPlatform;
}

export async function stageMacCuaHelperApp({
  electronPlatformName,
  resourcesDir,
  targetPlatform,
  zcodeCuaRoot,
  appVersion,
  buildIdentity,
  nodeExecutablePath,
  nodeVersion,
  nodeSha256,
  dependencyPackageRoots,
  readExecutableArchs = defaultReadExecutableArchs,
  prepareSeaExecutable = defaultPrepareSeaExecutable,
  compilePipPresenter = defaultCompilePipPresenter,
}) {
  if (electronPlatformName !== "darwin") return { staged: false };
  const macTarget = requireMacTarget(targetPlatform);
  if (!isNonEmptyTrimmedString(resourcesDir) || !isAbsolute(resourcesDir)) {
    throw new Error("[macos-cua-helper-app] resourcesDir must be an absolute path");
  }
  const buildVersion = createMacCuaBuildVersion(buildIdentity);
  const sourceNodePath = await requireNodeBuildInput({
    nodeExecutablePath,
    nodeVersion,
    nodeSha256,
    targetArch: macTarget.arch,
    readExecutableArchs,
  });

  const resourcesRoot = resolve(resourcesDir);
  const helperContainer = resolve(resourcesRoot, "cua-helper");
  const appRoot = resolve(helperContainer, MAC_CUA_HELPER_APP_NAME);
  const stagingRoot = resolve(helperContainer, `.cua-helper-stage-${randomUUID()}.app`);
  await mkdir(helperContainer, { recursive: true });
  await mkdir(resolve(stagingRoot, "Contents", "MacOS"), { recursive: true });
  const runtimeRoot = resolve(stagingRoot, ...RUNTIME_RELATIVE_PATH.split("/"));

  try {
    const runtime = await stageCuaRuntimeTree({
      targetPlatform: macTarget,
      zcodeCuaRoot,
      runtimeRoot,
      dependencyPackageRoots,
      runtimeContractName: "macos",
    });
    const infoPlistPath = resolve(stagingRoot, ...INFO_PLIST_RELATIVE_PATH.split("/"));
    await writeFile(infoPlistPath, createMacCuaInfoPlist(appVersion, buildVersion), "utf8");
    const executablePath = resolve(stagingRoot, ...EXECUTABLE_RELATIVE_PATH.split("/"));
    await prepareSeaExecutable({
      sourceNodePath,
      targetPath: executablePath,
      bootstrapSource: createMacCuaSeaBootstrapSource(),
    });
    await chmod(executablePath, 0o755);
    const presenterPath = resolve(stagingRoot, ...PIP_PRESENTER_RELATIVE_PATH.split("/"));
    const presenterSourcePath = await requirePipPresenterSource();
    await compilePipPresenter({
      sourcePath: presenterSourcePath,
      targetPath: presenterPath,
      targetArch: macTarget.arch,
      targetTriple: PIP_PRESENTER_TARGET_TRIPLES[macTarget.arch],
    });
    await requireCompiledPipPresenter({
      presenterPath,
      targetArch: macTarget.arch,
      readExecutableArchs,
    });
    await chmod(presenterPath, 0o755);

    const manifestFiles = await collectWindowsCuaRuntimeManifestFiles(await realpath(stagingRoot));
    const signedMutablePaths = manifestFiles
      .map((file) => file.path)
      .filter(
        (path) =>
          path === EXECUTABLE_RELATIVE_PATH ||
          path === PIP_PRESENTER_RELATIVE_PATH ||
          path.endsWith(".node"),
      );
    if (
      !signedMutablePaths.includes(EXECUTABLE_RELATIVE_PATH) ||
      !signedMutablePaths.includes(PIP_PRESENTER_RELATIVE_PATH)
    ) {
      throw new Error("[macos-cua-helper-app] staged Helper executables are missing from manifest");
    }
    const manifest = {
      schemaVersion: 1,
      packageName: runtime.packageName,
      packageVersion: runtime.packageVersion,
      appVersion,
      buildVersion,
      platform: "darwin",
      arch: macTarget.arch,
      nodeVersion: nodeVersion.replace(/^v/u, ""),
      bundleId: MAC_CUA_HELPER_BUNDLE_ID,
      executable: EXECUTABLE_RELATIVE_PATH,
      presenter: PIP_PRESENTER_RELATIVE_PATH,
      entry: requireCanonicalWindowsRuntimePath(runtime.entry, "runtime entry"),
      addon: requireCanonicalWindowsRuntimePath(runtime.addon, "native addon loader"),
      signedMutablePaths,
      files: manifestFiles,
    };
    const manifestPath = resolve(stagingRoot, ...MANIFEST_RELATIVE_PATH.split("/"));
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    await rm(appRoot, { recursive: true, force: true });
    await rename(stagingRoot, appRoot);
    return {
      staged: true,
      appRoot,
      runtimeRoot: resolve(appRoot, ...RUNTIME_RELATIVE_PATH.split("/")),
      executablePath: resolve(appRoot, ...EXECUTABLE_RELATIVE_PATH.split("/")),
      presenterPath: resolve(appRoot, ...PIP_PRESENTER_RELATIVE_PATH.split("/")),
      nativePackageName: runtime.nativePackageName,
      runtimeModules: runtime.runtimeModules,
      manifest,
    };
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

export function resolveMacCuaNodeBuildInput(env = process.env) {
  return {
    nodeExecutablePath: env[MAC_CUA_NODE_EXECUTABLE_ENV],
    nodeVersion: env[MAC_CUA_NODE_VERSION_ENV],
    nodeSha256: env[MAC_CUA_NODE_SHA256_ENV],
  };
}
