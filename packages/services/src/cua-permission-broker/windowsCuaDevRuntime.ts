/* eslint-disable max-lines -- source/product 两种解析模式共享同一稳定错误契约与路径校验，拆开会引入循环依赖 */
import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep, win32 as windowsPath } from "node:path";

const DEV_ROOT_ENV = "ZCODE_CUA_DEV_ROOT";
const EXPECTED_PACKAGE_NAME = "@zcode/zcode-cua";
const PACKAGE_JSON = "package.json";
const PRODUCT_RUNTIME_MANIFEST = "runtime-manifest.json";
const PRODUCT_RUNTIME_SEGMENTS = ["tools", "cua-helper"] as const;
const MAX_RUNTIME_MANIFEST_BYTES = 1024 * 1024;
const MAX_RUNTIME_FILES = 4096;
const SUPPORTED_NODE_PLATFORMS = ["linux", "win32"] as const;

type CuaNodePlatform = (typeof SUPPORTED_NODE_PLATFORMS)[number];

export interface WindowsCuaRuntime {
  platform: CuaNodePlatform;
  root: string;
  entryPath: string;
  addonPath: string;
  command: string;
  commandEnv: Record<string, string>;
}

/** 新代码使用平台中立名称；旧 Windows 名称保留给既有注入点。 */
export type CuaNodeRuntime = WindowsCuaRuntime;

interface WindowsCuaRuntimeFileSystem {
  stat(path: string): Promise<Pick<Stats, "isDirectory" | "isFile">>;
  lstat?(path: string): Promise<Pick<Stats, "isDirectory" | "isFile" | "isSymbolicLink">>;
  realpath?(path: string): Promise<string>;
  readdir?(path: string): Promise<string[]>;
  readFile(path: string, encoding?: "utf8"): Promise<string | Uint8Array>;
}

interface WindowsCuaRuntimeResolveOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  resourcesPath?: string;
  arch?: NodeJS.Architecture;
  electronVersion?: string;
  fileSystem?: WindowsCuaRuntimeFileSystem;
  hashBytes?: (bytes: string | Uint8Array) => Promise<string>;
}

type WindowsCuaDevRuntimeResolutionReason =
  | "unsupported-platform"
  | "development-root-not-absolute"
  | "development-root-not-found"
  | "invalid-package"
  | "missing-helper-entry"
  | "missing-native-addon"
  | "missing-resources-path"
  | "resources-path-not-absolute"
  | "invalid-runtime-manifest"
  | "incompatible-runtime-manifest"
  | "invalid-artifact-path"
  | "artifact-integrity-mismatch";

export class WindowsCuaDevRuntimeResolutionError extends Error {
  constructor(
    readonly reason: WindowsCuaDevRuntimeResolutionReason,
    message: string,
    readonly artifact?: string,
  ) {
    super(message);
    this.name = "WindowsCuaDevRuntimeResolutionError";
  }
}

const defaultFileSystem: WindowsCuaRuntimeFileSystem = {
  stat: (path) => fs.stat(path),
  lstat: (path) => fs.lstat(path),
  realpath: (path) => fs.realpath(path),
  readdir: (path) => fs.readdir(path),
  readFile: (path, encoding) =>
    encoding === "utf8" ? fs.readFile(path, encoding) : fs.readFile(path),
};
const defaultHashBytes = async (bytes: string | Uint8Array): Promise<string> =>
  createHash("sha256").update(bytes).digest("hex");

/**
 * Node 产品运行时解析边界（Windows/Linux）：
 * - 显式开发目录具有最高优先级，配置错误时 fail closed，不能悄悄改用安装资源；
 * - 产品模式只读取 resources/tools/cua-helper，不搜索源码目录或 node_modules。
 */
export async function resolveWindowsCuaRuntime(
  options: WindowsCuaRuntimeResolveOptions = {},
): Promise<WindowsCuaRuntime> {
  if ((options.platform ?? process.platform) !== "win32") {
    throw new WindowsCuaDevRuntimeResolutionError(
      "unsupported-platform",
      "Windows CUA runtime is only available on win32.",
    );
  }

  return resolveCuaNodeRuntime({ ...options, platform: "win32" });
}

export async function resolveCuaNodeRuntime(
  options: WindowsCuaRuntimeResolveOptions = {},
): Promise<CuaNodeRuntime> {
  const platform = options.platform ?? process.platform;
  if (!isCuaNodePlatform(platform)) {
    throw new WindowsCuaDevRuntimeResolutionError(
      "unsupported-platform",
      "CUA Node runtime is only available on win32 or linux.",
    );
  }

  const configuredRoot = (options.env ?? process.env)[DEV_ROOT_ENV]?.trim();
  if (configuredRoot) {
    return resolveDevelopmentRuntime(
      configuredRoot,
      options.fileSystem ?? defaultFileSystem,
      platform,
    );
  }

  return resolvePackagedRuntime(options, options.fileSystem ?? defaultFileSystem, platform);
}

function isCuaNodePlatform(platform: NodeJS.Platform): platform is CuaNodePlatform {
  return SUPPORTED_NODE_PLATFORMS.includes(platform as CuaNodePlatform);
}

async function resolveDevelopmentRuntime(
  configuredRoot: string,
  fileSystem: WindowsCuaRuntimeFileSystem,
  platform: CuaNodePlatform,
): Promise<WindowsCuaRuntime> {
  const isHostAbsolute = isAbsolute(configuredRoot);
  const isWindowsAbsolute = windowsPath.isAbsolute(configuredRoot);
  if (!isHostAbsolute && !isWindowsAbsolute) {
    throw new WindowsCuaDevRuntimeResolutionError(
      "development-root-not-absolute",
      `${DEV_ROOT_ENV} must be an absolute path.`,
    );
  }

  // 构建和测试会在非 Windows 主机校验 Windows runtime；宿主 path.isAbsolute
  // 不认识 C:\ 路径，不能在进入可注入文件系统前误判为相对路径。
  const root = isHostAbsolute ? resolve(configuredRoot) : windowsPath.normalize(configuredRoot);
  const rootRealPath = await requireDevelopmentRuntimeRoot(fileSystem, root);
  const producerContract = await requireExpectedPackage(
    fileSystem,
    join(root, PACKAGE_JSON),
    rootRealPath,
    platform,
  );

  const entryPath = resolveManifestArtifact(root, producerContract.entry, "entry");
  await requireContainedRegularArtifact(
    fileSystem,
    rootRealPath,
    entryPath,
    producerContract.entry,
    "missing-helper-entry",
    "entry",
  );

  const addonPath = resolveManifestArtifact(root, producerContract.addon, "addon");
  await requireContainedRegularArtifact(
    fileSystem,
    rootRealPath,
    addonPath,
    producerContract.addon,
    "missing-native-addon",
    "addon",
  );

  return {
    platform,
    root,
    entryPath,
    addonPath,
    command: process.execPath,
    commandEnv: { ELECTRON_RUN_AS_NODE: "1" },
  };
}

interface RuntimeManifest {
  schemaVersion: 1;
  packageName: typeof EXPECTED_PACKAGE_NAME;
  packageVersion: string;
  platform: CuaNodePlatform;
  arch: NodeJS.Architecture;
  electronVersion: string;
  entry: string;
  addon: string;
  files: RuntimeManifestFile[];
}

interface RuntimeManifestFile {
  path: string;
  sha256: string;
}

async function resolvePackagedRuntime(
  options: WindowsCuaRuntimeResolveOptions,
  fileSystem: WindowsCuaRuntimeFileSystem,
  platform: CuaNodePlatform,
): Promise<WindowsCuaRuntime> {
  const processResourcesPath = (process as NodeJS.Process & { resourcesPath?: string })
    .resourcesPath;
  const resourcesPath = (options.resourcesPath ?? processResourcesPath)?.trim();
  if (!resourcesPath) {
    throw new WindowsCuaDevRuntimeResolutionError(
      "missing-resources-path",
      "CUA Node packaged runtime requires resourcesPath.",
    );
  }
  if (!isAbsolute(resourcesPath)) {
    throw new WindowsCuaDevRuntimeResolutionError(
      "resources-path-not-absolute",
      "CUA Node packaged runtime resourcesPath must be absolute.",
    );
  }

  const root = resolve(resourcesPath, ...PRODUCT_RUNTIME_SEGMENTS);
  const rootRealPath = await requirePackagedRuntimeRoot(fileSystem, root);
  const manifestPath = join(root, PRODUCT_RUNTIME_MANIFEST);
  const manifest = await readRuntimeManifest(fileSystem, manifestPath, rootRealPath);
  const manifestFiles = validateRuntimeManifest(manifest, {
    platform,
    arch: options.arch ?? process.arch,
    electronVersion: options.electronVersion ?? process.versions.electron,
  });

  const entryPath = resolveManifestArtifact(root, manifest.entry, "entry");
  const addonPath = resolveManifestArtifact(root, manifest.addon, "addon");
  await Promise.all([
    requireContainedRegularArtifact(
      fileSystem,
      rootRealPath,
      entryPath,
      manifest.entry,
      "missing-helper-entry",
      "entry",
    ),
    requireContainedRegularArtifact(
      fileSystem,
      rootRealPath,
      addonPath,
      manifest.addon,
      "missing-native-addon",
      "addon",
    ),
  ]);
  const actualFiles = await collectPackagedRuntimeFiles(fileSystem, root, rootRealPath);
  requireExactRuntimeFileSet(manifestFiles, actualFiles);
  const hashBytes = options.hashBytes ?? defaultHashBytes;
  for (const file of manifestFiles) {
    const artifactPath = resolveManifestArtifact(root, file.path, file.path);
    const artifactKind =
      file.path === manifest.entry ? "entry" : file.path === manifest.addon ? "addon" : "file";
    const beforeRealPath = await requireContainedRuntimeFile(
      fileSystem,
      rootRealPath,
      artifactPath,
      file.path,
      artifactKind,
    );
    const bytes = await readRuntimeArtifact(fileSystem, artifactPath, file.path, artifactKind);
    const afterRealPath = await requireContainedRuntimeFile(
      fileSystem,
      rootRealPath,
      artifactPath,
      file.path,
      artifactKind,
    );
    // 根因：lstat/realpath 与 readFile 分步执行，读取期间被替换的路径不能继续启动。
    if (!samePhysicalPath(beforeRealPath, afterRealPath)) {
      throwInvalidArtifactPath(file.path);
    }
    const stableBytes = await readRuntimeArtifact(
      fileSystem,
      artifactPath,
      file.path,
      artifactKind,
    );
    const finalRealPath = await requireContainedRuntimeFile(
      fileSystem,
      rootRealPath,
      artifactPath,
      file.path,
      artifactKind,
    );
    if (!samePhysicalPath(afterRealPath, finalRealPath)) {
      throwInvalidArtifactPath(file.path);
    }
    const [firstHash, stableHash] = await Promise.all([hashBytes(bytes), hashBytes(stableBytes)]);
    requireArtifactHash(firstHash, stableHash, file.path);
    requireArtifactHash(stableHash, file.sha256, file.path);
  }
  // 根因：逐文件校验期间目录仍可能被增删；启动前再次锁定完整集合，不能只校验旧快照。
  requireExactRuntimeFileSet(
    manifestFiles,
    await collectPackagedRuntimeFiles(fileSystem, root, rootRealPath),
  );

  return {
    platform,
    root,
    entryPath,
    addonPath,
    command: process.execPath,
    commandEnv: { ELECTRON_RUN_AS_NODE: "1" },
  };
}

async function readRuntimeManifest(
  fileSystem: WindowsCuaRuntimeFileSystem,
  manifestPath: string,
  rootRealPath: string,
): Promise<RuntimeManifest> {
  try {
    const stats = await lstatFile(fileSystem, manifestPath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error("manifest is not a regular file");
    }
    const manifestRealPath = await realpathFile(fileSystem, manifestPath);
    if (!isPathContainedBy(rootRealPath, manifestRealPath)) {
      throw new Error("manifest escapes runtime root");
    }
    const contents = await fileSystem.readFile(manifestPath, "utf8");
    if (typeof contents !== "string" || contents.length > MAX_RUNTIME_MANIFEST_BYTES) {
      throw new Error("manifest is not bounded text");
    }
    const postReadStats = await lstatFile(fileSystem, manifestPath);
    const postReadRealPath = await realpathFile(fileSystem, manifestPath);
    if (
      !postReadStats.isFile() ||
      postReadStats.isSymbolicLink() ||
      !samePhysicalPath(manifestRealPath, postReadRealPath)
    ) {
      throw new Error("manifest changed while being read");
    }
    const value: unknown = JSON.parse(contents);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("manifest is not an object");
    }
    return value as RuntimeManifest;
  } catch {
    throw new WindowsCuaDevRuntimeResolutionError(
      "invalid-runtime-manifest",
      `CUA Node packaged runtime has an invalid ${PRODUCT_RUNTIME_MANIFEST}.`,
      PRODUCT_RUNTIME_MANIFEST,
    );
  }
}

async function requirePackagedRuntimeRoot(
  fileSystem: WindowsCuaRuntimeFileSystem,
  root: string,
): Promise<string> {
  try {
    const stats = await lstatFile(fileSystem, root);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error("runtime root is not a regular directory");
    }
    const rootRealPath = await realpathFile(fileSystem, root);
    if (!samePhysicalPath(root, rootRealPath)) {
      throw new Error("runtime root resolves outside its packaged location");
    }
    return rootRealPath;
  } catch {
    throw new WindowsCuaDevRuntimeResolutionError(
      "invalid-runtime-manifest",
      `CUA Node packaged runtime has an invalid ${PRODUCT_RUNTIME_MANIFEST}.`,
      PRODUCT_RUNTIME_MANIFEST,
    );
  }
}

function validateRuntimeManifest(
  manifest: RuntimeManifest,
  expected: {
    platform: CuaNodePlatform;
    arch: NodeJS.Architecture;
    electronVersion?: string;
  },
): RuntimeManifestFile[] {
  const hashPattern = /^[0-9a-f]{64}$/u;
  const hasExactManifestKeys = hasExactKeys(manifest, [
    "schemaVersion",
    "packageName",
    "packageVersion",
    "platform",
    "arch",
    "electronVersion",
    "entry",
    "addon",
    "files",
  ]);
  const compatible =
    hasExactManifestKeys &&
    manifest.schemaVersion === 1 &&
    manifest.packageName === EXPECTED_PACKAGE_NAME &&
    isNonEmptyTrimmedString(manifest.packageVersion) &&
    manifest.platform === expected.platform &&
    (manifest.arch === "x64" || manifest.arch === "arm64") &&
    manifest.arch === expected.arch &&
    typeof expected.electronVersion === "string" &&
    expected.electronVersion.length > 0 &&
    manifest.electronVersion === expected.electronVersion &&
    isCanonicalRelativeArtifactPath(manifest.entry) &&
    isCanonicalRelativeArtifactPath(manifest.addon) &&
    manifest.entry !== manifest.addon &&
    Array.isArray(manifest.files) &&
    manifest.files.length > 0 &&
    manifest.files.length <= MAX_RUNTIME_FILES;
  if (compatible) {
    const declaredPaths = new Set<string>();
    const seenWindowsPaths = new Set<string>();
    let previousPath = "";
    let allFilesValid = true;
    for (const file of manifest.files) {
      const validFile =
        isPlainRecord(file) &&
        hasExactKeys(file, ["path", "sha256"]) &&
        isCanonicalRelativeArtifactPath(file.path) &&
        file.path !== PRODUCT_RUNTIME_MANIFEST &&
        hashPattern.test(file.sha256) &&
        (previousPath === "" || compareCanonicalPaths(previousPath, file.path) < 0) &&
        !seenWindowsPaths.has(file.path.toLowerCase());
      if (!validFile) {
        allFilesValid = false;
        break;
      }
      declaredPaths.add(file.path);
      seenWindowsPaths.add(file.path.toLowerCase());
      previousPath = file.path;
    }
    const expectedNativePackage =
      manifest.platform === "win32"
        ? `node_modules/@crowecawcaw/xa11y-win32-${manifest.arch}-msvc`
        : `node_modules/@crowecawcaw/xa11y-linux-${manifest.arch}-gnu`;
    const expectedNativeBinary =
      manifest.platform === "win32"
        ? `xa11y.win32-${manifest.arch}-msvc.node`
        : `xa11y.linux-${manifest.arch}-gnu.node`;
    const requiredFiles = [
      PACKAGE_JSON,
      manifest.entry,
      manifest.addon,
      "node_modules/@crowecawcaw/xa11y/package.json",
      "node_modules/@crowecawcaw/xa11y/index.js",
      "node_modules/@crowecawcaw/xa11y/native.js",
      `${expectedNativePackage}/package.json`,
      `${expectedNativePackage}/${expectedNativeBinary}`,
    ];
    if (allFilesValid && requiredFiles.every((path) => declaredPaths.has(path))) {
      return manifest.files;
    }
  }
  throw new WindowsCuaDevRuntimeResolutionError(
    "incompatible-runtime-manifest",
    `CUA Node packaged runtime ${PRODUCT_RUNTIME_MANIFEST} is incompatible with this runtime.`,
    PRODUCT_RUNTIME_MANIFEST,
  );
}

async function requireDevelopmentRuntimeRoot(
  fileSystem: WindowsCuaRuntimeFileSystem,
  root: string,
): Promise<string> {
  try {
    const stats = await lstatFile(fileSystem, root);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error("development root is not a regular directory");
    }
    const rootRealPath = await realpathFile(fileSystem, root);
    // 根因：stat 会跟随 symlink/junction；开发目录必须绑定到用户显式配置的物理根。
    if (!samePhysicalPath(root, rootRealPath)) {
      throw new Error("development root resolves outside its configured location");
    }
    return rootRealPath;
  } catch {
    throw new WindowsCuaDevRuntimeResolutionError(
      "development-root-not-found",
      `${DEV_ROOT_ENV} must reference an existing regular directory.`,
    );
  }
}

function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function hasExactKeys(value: object, expectedKeys: readonly string[]): boolean {
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  return (
    actualKeys.length === sortedExpectedKeys.length &&
    actualKeys.every((key, index) => key === sortedExpectedKeys[index])
  );
}

function compareCanonicalPaths(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

async function collectPackagedRuntimeFiles(
  fileSystem: WindowsCuaRuntimeFileSystem,
  root: string,
  rootRealPath: string,
): Promise<string[]> {
  const files: string[] = [];
  let visitedDirectories = 0;

  const visitDirectory = async (relativeDirectory: string): Promise<void> => {
    visitedDirectories += 1;
    if (visitedDirectories > MAX_RUNTIME_FILES) {
      throwArtifactIntegrityMismatch(relativeDirectory || ".");
    }
    const directoryPath = relativeDirectory
      ? resolveManifestArtifact(root, relativeDirectory, relativeDirectory)
      : root;
    const beforeRealPath = relativeDirectory
      ? await requireContainedRuntimeDirectory(
          fileSystem,
          rootRealPath,
          directoryPath,
          relativeDirectory,
        )
      : rootRealPath;
    let names: string[];
    try {
      names = await readdirFile(fileSystem, directoryPath);
    } catch {
      throwArtifactIntegrityMismatch(relativeDirectory || ".");
    }
    names.sort(compareCanonicalPaths);
    const seenWindowsNames = new Set<string>();

    for (const name of names) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      if (
        !isCanonicalRelativeArtifactPath(relativePath) ||
        seenWindowsNames.has(name.toLowerCase())
      ) {
        throwInvalidArtifactPath(relativePath);
      }
      seenWindowsNames.add(name.toLowerCase());
      const artifactPath = resolveManifestArtifact(root, relativePath, relativePath);
      let stats: Pick<Stats, "isDirectory" | "isFile" | "isSymbolicLink">;
      try {
        stats = await lstatFile(fileSystem, artifactPath);
      } catch {
        throwArtifactIntegrityMismatch(relativePath);
      }
      if (stats.isSymbolicLink()) throwInvalidArtifactPath(relativePath);
      if (stats.isDirectory()) {
        await visitDirectory(relativePath);
      } else if (stats.isFile()) {
        const physicalPath = await realpathFile(fileSystem, artifactPath);
        if (!isPathContainedBy(rootRealPath, physicalPath)) {
          throwInvalidArtifactPath(relativePath);
        }
        if (relativePath !== PRODUCT_RUNTIME_MANIFEST) files.push(relativePath);
        if (files.length > MAX_RUNTIME_FILES) throwArtifactIntegrityMismatch(relativePath);
      } else {
        throwInvalidArtifactPath(relativePath);
      }
    }

    const afterRealPath = relativeDirectory
      ? await requireContainedRuntimeDirectory(
          fileSystem,
          rootRealPath,
          directoryPath,
          relativeDirectory,
        )
      : await requirePackagedRuntimeRoot(fileSystem, root);
    if (!samePhysicalPath(beforeRealPath, afterRealPath)) {
      throwInvalidArtifactPath(relativeDirectory || ".");
    }
  };

  await visitDirectory("");
  return files.sort(compareCanonicalPaths);
}

async function requireContainedRuntimeDirectory(
  fileSystem: WindowsCuaRuntimeFileSystem,
  rootRealPath: string,
  directoryPath: string,
  artifact: string,
): Promise<string> {
  try {
    const stats = await lstatFile(fileSystem, directoryPath);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("not a regular directory");
    const physicalPath = await realpathFile(fileSystem, directoryPath);
    if (!isPathContainedBy(rootRealPath, physicalPath)) throw new Error("directory escapes root");
    return physicalPath;
  } catch {
    throwInvalidArtifactPath(artifact);
  }
}

function requireExactRuntimeFileSet(
  manifestFiles: readonly RuntimeManifestFile[],
  actualFiles: readonly string[],
): void {
  const declaredFiles = manifestFiles.map((file) => file.path);
  const length = Math.max(declaredFiles.length, actualFiles.length);
  for (let index = 0; index < length; index += 1) {
    if (declaredFiles[index] !== actualFiles[index]) {
      throwArtifactIntegrityMismatch(actualFiles[index] ?? declaredFiles[index] ?? ".");
    }
  }
}

function resolveManifestArtifact(root: string, artifact: string, field: string): string {
  // 测试和构建编排可能在非 Windows 主机上检查 Windows 清单；仅用宿主 path.isAbsolute
  // 会把 C:\... 误判成相对路径，因此同时按 Windows 路径语义 fail closed。
  if (!isCanonicalRelativeArtifactPath(artifact)) {
    throwInvalidArtifactPath(field);
  }
  const artifactPath =
    windowsPath.isAbsolute(root) && !isAbsolute(root)
      ? join(root, ...artifact.split("/"))
      : resolve(root, ...artifact.split("/"));
  const relativePath = relative(root, artifactPath);
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throwInvalidArtifactPath(field);
  }
  return artifactPath;
}

function isCanonicalRelativeArtifactPath(artifact: unknown): artifact is string {
  if (
    typeof artifact !== "string" ||
    !artifact ||
    artifact.length > 4096 ||
    artifact.includes("\\") ||
    isAbsolute(artifact) ||
    windowsPath.isAbsolute(artifact) ||
    windowsPath.normalize(artifact).replaceAll("\\", "/") !== artifact
  ) {
    return false;
  }
  return !artifact
    .split("/")
    .some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment.endsWith(".") ||
        segment.endsWith(" ") ||
        /^(?:aux|con|nul|prn|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment) ||
        segment.includes(":") ||
        segment.includes("\0"),
    );
}

async function requireContainedRegularArtifact(
  fileSystem: WindowsCuaRuntimeFileSystem,
  rootRealPath: string,
  artifactPath: string,
  artifact: string,
  missingReason: "missing-helper-entry" | "missing-native-addon",
  artifactKind: "entry" | "addon",
): Promise<string> {
  let stats: Pick<Stats, "isFile" | "isSymbolicLink">;
  try {
    stats = await lstatFile(fileSystem, artifactPath);
  } catch {
    throwMissingArtifact(missingReason, artifact, artifactKind);
  }
  if (stats.isSymbolicLink()) {
    throwInvalidArtifactPath(artifactKind);
  }
  if (!stats.isFile()) {
    throwMissingArtifact(missingReason, artifact, artifactKind);
  }
  try {
    const artifactRealPath = await realpathFile(fileSystem, artifactPath);
    if (!isPathContainedBy(rootRealPath, artifactRealPath)) {
      throwInvalidArtifactPath(artifactKind);
    }
    return artifactRealPath;
  } catch (error) {
    if (error instanceof WindowsCuaDevRuntimeResolutionError) throw error;
    throwMissingArtifact(missingReason, artifact, artifactKind);
  }
}

async function requireContainedRuntimeFile(
  fileSystem: WindowsCuaRuntimeFileSystem,
  rootRealPath: string,
  artifactPath: string,
  artifact: string,
  artifactKind: "entry" | "addon" | "file",
): Promise<string> {
  if (artifactKind === "entry") {
    return requireContainedRegularArtifact(
      fileSystem,
      rootRealPath,
      artifactPath,
      artifact,
      "missing-helper-entry",
      "entry",
    );
  }
  if (artifactKind === "addon") {
    return requireContainedRegularArtifact(
      fileSystem,
      rootRealPath,
      artifactPath,
      artifact,
      "missing-native-addon",
      "addon",
    );
  }
  try {
    const stats = await lstatFile(fileSystem, artifactPath);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("not a regular file");
    const physicalPath = await realpathFile(fileSystem, artifactPath);
    if (!isPathContainedBy(rootRealPath, physicalPath)) throw new Error("file escapes root");
    return physicalPath;
  } catch {
    throwInvalidArtifactPath(artifact);
  }
}

function throwMissingArtifact(
  reason: "missing-helper-entry" | "missing-native-addon",
  artifact: string,
  artifactKind: "entry" | "addon",
): never {
  throw new WindowsCuaDevRuntimeResolutionError(
    reason,
    `CUA Node runtime is missing required ${artifactKind}: ${artifact}.`,
    artifact,
  );
}

function lstatFile(
  fileSystem: WindowsCuaRuntimeFileSystem,
  path: string,
): Promise<Pick<Stats, "isDirectory" | "isFile" | "isSymbolicLink">> {
  return (fileSystem.lstat ?? defaultFileSystem.lstat!)(path);
}

function realpathFile(fileSystem: WindowsCuaRuntimeFileSystem, path: string): Promise<string> {
  return (fileSystem.realpath ?? defaultFileSystem.realpath!)(path);
}

function readdirFile(fileSystem: WindowsCuaRuntimeFileSystem, path: string): Promise<string[]> {
  return (fileSystem.readdir ?? defaultFileSystem.readdir!)(path);
}

function isPathContainedBy(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return (
    relativePath.length > 0 &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

function samePhysicalPath(expected: string, actual: string): boolean {
  const normalize = (path: string): string => {
    if (windowsPath.isAbsolute(path)) return windowsPath.normalize(path).toLowerCase();
    return resolve(path);
  };
  return normalize(expected) === normalize(actual);
}

async function readRuntimeArtifact(
  fileSystem: WindowsCuaRuntimeFileSystem,
  artifactPath: string,
  artifact: string,
  artifactKind: "entry" | "addon" | "file",
): Promise<string | Uint8Array> {
  try {
    return await fileSystem.readFile(artifactPath);
  } catch {
    if (artifactKind === "entry") {
      throwMissingArtifact("missing-helper-entry", artifact, "entry");
    }
    if (artifactKind === "addon") {
      throwMissingArtifact("missing-native-addon", artifact, "addon");
    }
    throwArtifactIntegrityMismatch(artifact);
  }
}

function throwInvalidArtifactPath(field: string): never {
  throw new WindowsCuaDevRuntimeResolutionError(
    "invalid-artifact-path",
    `CUA Node packaged runtime ${field} must be a contained relative artifact path.`,
    field,
  );
}

function requireArtifactHash(actualHash: string, expectedHash: string, artifact: string): void {
  if (actualHash === expectedHash) return;
  throwArtifactIntegrityMismatch(artifact);
}

function throwArtifactIntegrityMismatch(artifact: string): never {
  throw new WindowsCuaDevRuntimeResolutionError(
    "artifact-integrity-mismatch",
    `CUA Node packaged runtime ${artifact} failed SHA-256 verification.`,
    artifact,
  );
}

async function requireExpectedPackage(
  fileSystem: WindowsCuaRuntimeFileSystem,
  packagePath: string,
  rootRealPath: string,
  platform: CuaNodePlatform,
): Promise<{ packageVersion: string; entry: string; addon: string }> {
  try {
    const stats = await lstatFile(fileSystem, packagePath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error("package.json is not a regular file");
    }
    const packageRealPath = await realpathFile(fileSystem, packagePath);
    if (!isPathContainedBy(rootRealPath, packageRealPath)) {
      throw new Error("package.json escapes development root");
    }
    const contents = await fileSystem.readFile(packagePath, "utf8");
    if (typeof contents !== "string") throw new Error("package.json is not text");
    const pkg: unknown = JSON.parse(contents);
    if (!isPlainRecord(pkg)) throw new Error("package.json is not an object");
    const contract = pkg.zcodeCuaRuntime;
    const contractKeys = isPlainRecord(contract) ? Object.keys(contract) : [];
    const platformContractKey = platform === "win32" ? "windows" : "linux";
    const platformContract = isPlainRecord(contract) ? contract[platformContractKey] : undefined;
    if (
      pkg.name !== EXPECTED_PACKAGE_NAME ||
      !isNonEmptyTrimmedString(pkg.version) ||
      !isPlainRecord(contract) ||
      !contractKeys.includes("schema") ||
      !contractKeys.includes(platformContractKey) ||
      !contractKeys.every(
        (key) => key === "schema" || key === "windows" || key === "linux" || key === "macos",
      ) ||
      contract.schema !== 1 ||
      !isPlainRecord(platformContract) ||
      !hasExactKeys(platformContract, ["entry", "nativeAddon"]) ||
      !isCanonicalRelativeArtifactPath(platformContract.entry) ||
      !isCanonicalRelativeArtifactPath(platformContract.nativeAddon) ||
      platformContract.entry === platformContract.nativeAddon
    ) {
      throw new Error("package runtime contract is incompatible");
    }
    // 根因：Linux contract 加入后，旧白名单会把整个当前 package 判成非法，且即使放宽
    // 白名单仍固定读取 windows 字段。开发根目录必须与打包路径一样按目标平台选唯一 contract。
    return {
      packageVersion: pkg.version,
      entry: platformContract.entry,
      addon: platformContract.nativeAddon,
    };
  } catch {
    // 解析和 I/O 失败共用稳定的 package 诊断，避免依赖底层错误文本。
  }
  throw new WindowsCuaDevRuntimeResolutionError(
    "invalid-package",
    `CUA Node development root package.json must name ${EXPECTED_PACKAGE_NAME} and expose a valid zcodeCuaRuntime contract.`,
    PACKAGE_JSON,
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
