/* eslint-disable max-lines -- Runtime closure validation and atomic staging share one integrity boundary. */
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import ts from "typescript";
import {
  collectWindowsCuaRuntimeManifestFiles,
  compareCanonicalPaths,
  requireCanonicalWindowsRuntimePath,
} from "./windows-cua-runtime-manifest.mjs";

const EXPECTED_PACKAGE_NAME = "@zcode/zcode-cua";
const XA11Y_PACKAGE_NAME = "@crowecawcaw/xa11y";
const RUNTIME_MANIFEST_NAME = "runtime-manifest.json";
const NODE_RUNTIME_SEGMENTS = ["resources", "tools", "cua-helper"];
const ELF_CLASS_64 = 2;
const ELF_DATA_LITTLE_ENDIAN = 1;
const ELF_TYPE_SHARED_OBJECT = 3;
const MAX_LINUX_GLIBC_VERSION = [2, 28, 0];
const LINUX_ELF_MACHINE = {
  arm64: 183,
  x64: 62,
};

const XA11Y_NATIVE_PACKAGES = {
  darwin: {
    arm64: "@crowecawcaw/xa11y-darwin-arm64",
    x64: "@crowecawcaw/xa11y-darwin-x64",
  },
  linux: {
    arm64: "@crowecawcaw/xa11y-linux-arm64-gnu",
    x64: "@crowecawcaw/xa11y-linux-x64-gnu",
  },
  win32: {
    arm64: "@crowecawcaw/xa11y-win32-arm64-msvc",
    x64: "@crowecawcaw/xa11y-win32-x64-msvc",
  },
};

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyTrimmedString(value) {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function compareVersionParts(left, right) {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function requireCompatibleLinuxNativeElf(bytes, arch, label) {
  const expectedMachine = LINUX_ELF_MACHINE[arch];
  if (
    expectedMachine === undefined ||
    bytes.length < 20 ||
    bytes[0] !== 0x7f ||
    bytes[1] !== 0x45 ||
    bytes[2] !== 0x4c ||
    bytes[3] !== 0x46 ||
    bytes[4] !== ELF_CLASS_64 ||
    bytes[5] !== ELF_DATA_LITTLE_ENDIAN ||
    bytes[16] !== ELF_TYPE_SHARED_OBJECT ||
    bytes[17] !== 0
  ) {
    throw new Error(
      `[windows-cua-runtime-assets] ${label} must be a 64-bit little-endian ELF shared object`,
    );
  }
  const machine = bytes[18] | (bytes[19] << 8);
  if (machine !== expectedMachine) {
    throw new Error(
      `[windows-cua-runtime-assets] ${label} ELF architecture does not match linux-${arch}`,
    );
  }

  const contents = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
  const versions = Array.from(contents.matchAll(/GLIBC_(\d+)\.(\d+)(?:\.(\d+))?/gu), (match) => ({
    label: match[0],
    parts: [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)],
  }));
  if (versions.length === 0) {
    throw new Error(
      `[windows-cua-runtime-assets] ${label} has no GLIBC symbol version requirements`,
    );
  }
  const highest = versions.reduce((current, candidate) =>
    compareVersionParts(candidate.parts, current.parts) > 0 ? candidate : current,
  );
  if (compareVersionParts(highest.parts, MAX_LINUX_GLIBC_VERSION) > 0) {
    throw new Error(
      `[windows-cua-runtime-assets] ${label} requires ${highest.label}; maximum supported is GLIBC_2.28`,
    );
  }
}

function isPathContainedBy(root, candidate) {
  const relativePath = relative(root, candidate);
  return (
    relativePath === "" ||
    (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  );
}

async function requireRegularFile(rootRealPath, relativePath, label) {
  const canonicalPath = requireCanonicalWindowsRuntimePath(relativePath, label);
  const absolutePath = resolve(rootRealPath, ...canonicalPath.split("/"));
  if (!isPathContainedBy(rootRealPath, absolutePath) || absolutePath === rootRealPath) {
    throw new Error(`[windows-cua-runtime-assets] ${label} escapes its package root`);
  }

  let stats;
  try {
    stats = await lstat(absolutePath);
  } catch {
    throw new Error(`[windows-cua-runtime-assets] missing ${label}: ${canonicalPath}`);
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`[windows-cua-runtime-assets] ${label} must be a regular file`);
  }
  const physicalPath = await realpath(absolutePath);
  if (!isPathContainedBy(rootRealPath, physicalPath)) {
    throw new Error(`[windows-cua-runtime-assets] ${label} resolves outside its package root`);
  }
  return physicalPath;
}

async function readJsonFile(path, label) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (!isPlainObject(value)) throw new Error("not an object");
    return value;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`[windows-cua-runtime-assets] invalid ${label}: ${detail}`);
  }
}

function findLocalModuleSpecifiers(source, fileName) {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  if (sourceFile.parseDiagnostics.length > 0) {
    const firstDiagnostic = sourceFile.parseDiagnostics[0];
    const detail = ts.flattenDiagnosticMessageText(firstDiagnostic.messageText, " ");
    throw new Error(
      `[windows-cua-runtime-assets] cannot parse runtime module ${fileName}: ${detail}`,
    );
  }
  const specifiers = new Set();
  const collect = (node) => {
    const staticSpecifier =
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
        ? node.moduleSpecifier.text
        : undefined;
    const dynamicSpecifier =
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0])
        ? node.arguments[0].text
        : undefined;
    for (const specifier of [staticSpecifier, dynamicSpecifier]) {
      if (specifier?.startsWith("./") || specifier?.startsWith("../")) {
        specifiers.add(specifier);
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(sourceFile);
  return [...specifiers];
}

async function collectRuntimeModuleClosure(packageRootRealPath, entryPaths) {
  const pending = [...entryPaths];
  const visited = new Set();

  while (pending.length > 0) {
    const relativePath = pending.pop();
    if (visited.has(relativePath)) continue;
    const sourcePath = await requireRegularFile(
      packageRootRealPath,
      relativePath,
      `runtime module ${relativePath}`,
    );
    if (!relativePath.endsWith(".js")) {
      throw new Error(
        `[windows-cua-runtime-assets] runtime module must use an explicit .js path: ${relativePath}`,
      );
    }
    visited.add(relativePath);

    const source = await readFile(sourcePath, "utf8");
    for (const specifier of findLocalModuleSpecifiers(source, relativePath)) {
      if (specifier.includes("?") || specifier.includes("#")) {
        throw new Error(
          `[windows-cua-runtime-assets] runtime import must not use query/hash syntax: ${specifier}`,
        );
      }
      const importedPath = resolve(dirname(sourcePath), specifier);
      if (!isPathContainedBy(packageRootRealPath, importedPath)) {
        throw new Error(
          `[windows-cua-runtime-assets] runtime import escapes package root: ${specifier}`,
        );
      }
      const importedRelativePath = relative(packageRootRealPath, importedPath).replaceAll(sep, "/");
      requireCanonicalWindowsRuntimePath(importedRelativePath, `runtime import ${specifier}`);
      pending.push(importedRelativePath);
    }
  }

  return [...visited].sort(compareCanonicalPaths);
}

async function copyRegularFile(sourcePath, targetPath) {
  await mkdir(dirname(targetPath), { recursive: true });
  await copyFile(sourcePath, targetPath);
}

async function copyPackageTree(sourceRootRealPath, targetRoot, relativeDirectory = "") {
  const sourceDirectory = relativeDirectory
    ? resolve(sourceRootRealPath, ...relativeDirectory.split("/"))
    : sourceRootRealPath;
  const entries = await readdir(sourceDirectory, { withFileTypes: true });
  entries.sort((left, right) => compareCanonicalPaths(left.name, right.name));

  for (const entry of entries) {
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) {
      throw new Error(
        `[windows-cua-runtime-assets] dependency package contains a symlink: ${relativePath}`,
      );
    }
    if (entry.isDirectory()) {
      await copyPackageTree(sourceRootRealPath, targetRoot, relativePath);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(
        `[windows-cua-runtime-assets] dependency package contains a non-file asset: ${relativePath}`,
      );
    }
    const sourcePath = await requireRegularFile(
      sourceRootRealPath,
      relativePath,
      `dependency asset ${relativePath}`,
    );
    await copyRegularFile(sourcePath, resolve(targetRoot, ...relativePath.split("/")));
  }
}

function defaultResolveDependencyPackageRoot(packageName, zcodeCuaRoot) {
  const requireFromCua = createRequire(resolve(zcodeCuaRoot, "package.json"));
  return dirname(requireFromCua.resolve(`${packageName}/package.json`));
}

async function resolveDependencyPackage({ packageName, zcodeCuaRoot, dependencyPackageRoots }) {
  const configuredRoot = dependencyPackageRoots?.[packageName];
  let packageRoot;
  try {
    packageRoot = configuredRoot ?? defaultResolveDependencyPackageRoot(packageName, zcodeCuaRoot);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `[windows-cua-runtime-assets] cannot resolve dependency ${packageName}: ${detail}`,
    );
  }
  const packageRootRealPath = await realpath(resolve(packageRoot));
  const packageJsonPath = await requireRegularFile(
    packageRootRealPath,
    "package.json",
    `${packageName} package.json`,
  );
  const packageJson = await readJsonFile(packageJsonPath, `${packageName} package.json`);
  if (packageJson.name !== packageName || !isNonEmptyTrimmedString(packageJson.version)) {
    throw new Error(`[windows-cua-runtime-assets] dependency identity mismatch: ${packageName}`);
  }
  return { packageJson, packageRootRealPath };
}

function requireCuaTarget(electronPlatformName, targetPlatform) {
  const nativePackages = XA11Y_NATIVE_PACKAGES[electronPlatformName];
  const expectedKey = `${electronPlatformName}-${targetPlatform?.arch}`;
  if (
    !nativePackages ||
    targetPlatform?.os !== electronPlatformName ||
    !Object.hasOwn(nativePackages, targetPlatform?.arch) ||
    targetPlatform?.key !== expectedKey
  ) {
    throw new Error(
      `[windows-cua-runtime-assets] unsupported CUA Node target: ${String(targetPlatform?.key)}`,
    );
  }
  return { ...targetPlatform, nativePackageName: nativePackages[targetPlatform.arch] };
}

/**
 * Populates an empty Helper runtime directory with the repository-owned JS closure and exactly
 * one xa11y native package. Platform wrappers own the outer bundle and integrity manifest.
 */
export async function stageCuaRuntimeTree({
  targetPlatform,
  zcodeCuaRoot,
  runtimeRoot,
  dependencyPackageRoots,
  runtimeContractName = targetPlatform?.os === "darwin"
    ? "macos"
    : targetPlatform?.os === "linux"
      ? "linux"
      : "windows",
}) {
  const cuaTarget = requireCuaTarget(targetPlatform?.os, targetPlatform);
  if (!isNonEmptyTrimmedString(zcodeCuaRoot) || !isAbsolute(zcodeCuaRoot)) {
    throw new Error("[windows-cua-runtime-assets] zcodeCuaRoot must be an absolute path");
  }
  if (!isNonEmptyTrimmedString(runtimeRoot) || !isAbsolute(runtimeRoot)) {
    throw new Error("[windows-cua-runtime-assets] runtimeRoot must be an absolute path");
  }

  const sourceRootRealPath = await realpath(resolve(zcodeCuaRoot));
  const packageJsonPath = await requireRegularFile(
    sourceRootRealPath,
    "package.json",
    "zcode-cua package.json",
  );
  const packageJson = await readJsonFile(packageJsonPath, "zcode-cua package.json");
  const runtimeContract = packageJson.zcodeCuaRuntime;
  const platformContract = isPlainObject(runtimeContract)
    ? runtimeContract[runtimeContractName]
    : null;
  if (
    packageJson.name !== EXPECTED_PACKAGE_NAME ||
    !isNonEmptyTrimmedString(packageJson.version) ||
    !isPlainObject(runtimeContract) ||
    runtimeContract.schema !== 1 ||
    !isPlainObject(platformContract)
  ) {
    throw new Error(
      `[windows-cua-runtime-assets] invalid zcode-cua ${runtimeContractName} runtime contract`,
    );
  }
  const entry = requireCanonicalWindowsRuntimePath(platformContract.entry, "runtime entry");
  const addon = requireCanonicalWindowsRuntimePath(
    platformContract.nativeAddon,
    "native addon loader",
  );
  if (entry !== "helper-entry.js" || addon !== "xa11y-native-loader.js" || entry === addon) {
    throw new Error("[windows-cua-runtime-assets] unexpected zcode-cua runtime artifacts");
  }

  const runtimeModules = await collectRuntimeModuleClosure(sourceRootRealPath, [entry, addon]);
  const xa11yPackage = await resolveDependencyPackage({
    packageName: XA11Y_PACKAGE_NAME,
    zcodeCuaRoot: sourceRootRealPath,
    dependencyPackageRoots,
  });
  const nativePackageName = cuaTarget.nativePackageName;
  const nativePackage = await resolveDependencyPackage({
    packageName: nativePackageName,
    zcodeCuaRoot: sourceRootRealPath,
    dependencyPackageRoots,
  });
  if (nativePackage.packageJson.version !== xa11yPackage.packageJson.version) {
    throw new Error(
      `[windows-cua-runtime-assets] xa11y native package version mismatch: ${nativePackage.packageJson.version} != ${xa11yPackage.packageJson.version}`,
    );
  }
  const nativeMain = requireCanonicalWindowsRuntimePath(
    nativePackage.packageJson.main,
    `${nativePackageName} main`,
  );
  await requireRegularFile(
    nativePackage.packageRootRealPath,
    nativeMain,
    `${nativePackageName} main`,
  );

  await mkdir(runtimeRoot, { recursive: true });
  if ((await readdir(runtimeRoot)).length > 0) {
    throw new Error("[windows-cua-runtime-assets] runtimeRoot must be empty");
  }
  await copyRegularFile(packageJsonPath, resolve(runtimeRoot, "package.json"));
  for (const runtimeModule of runtimeModules) {
    const sourcePath = await requireRegularFile(
      sourceRootRealPath,
      runtimeModule,
      `runtime module ${runtimeModule}`,
    );
    await copyRegularFile(sourcePath, resolve(runtimeRoot, ...runtimeModule.split("/")));
  }

  const xa11yTargetRoot = resolve(runtimeRoot, "node_modules", ...XA11Y_PACKAGE_NAME.split("/"));
  const nativeTargetRoot = resolve(runtimeRoot, "node_modules", ...nativePackageName.split("/"));
  await copyPackageTree(xa11yPackage.packageRootRealPath, xa11yTargetRoot);
  await copyPackageTree(nativePackage.packageRootRealPath, nativeTargetRoot);
  if (targetPlatform.os === "linux") {
    // 根因：npm 预编译包会继承发布 runner 的 glibc；`-gnu` 包名不代表满足产品的
    // RHEL 8 基线。校验最终 staging 字节，避免直到用户机器 dlopen 时才暴露不兼容。
    requireCompatibleLinuxNativeElf(
      await readFile(resolve(nativeTargetRoot, ...nativeMain.split("/"))),
      targetPlatform.arch,
      `${nativePackageName} main`,
    );
  }
  return {
    packageName: EXPECTED_PACKAGE_NAME,
    packageVersion: packageJson.version,
    entry,
    addon,
    runtimeModules,
    nativePackageName,
  };
}

/**
 * Stages the Windows/Linux CUA Helper runtime outside app.asar.
 * The helper package owns this asset tree; desktop only invokes this deterministic build step.
 */
export async function stageCuaNodeRuntimeAssets({
  electronPlatformName,
  appOutDir,
  targetPlatform,
  electronVersion,
  zcodeCuaRoot,
  dependencyPackageRoots,
}) {
  if (electronPlatformName !== "win32" && electronPlatformName !== "linux") {
    return { staged: false };
  }
  const nodeTarget = requireCuaTarget(electronPlatformName, targetPlatform);
  if (!isNonEmptyTrimmedString(electronVersion)) {
    throw new Error("[windows-cua-runtime-assets] electronVersion is required");
  }
  if (!isNonEmptyTrimmedString(appOutDir) || !isAbsolute(appOutDir)) {
    throw new Error("[windows-cua-runtime-assets] appOutDir must be an absolute path");
  }
  const appOutRoot = resolve(appOutDir);
  const runtimeRoot = resolve(appOutRoot, ...NODE_RUNTIME_SEGMENTS);
  if (!isPathContainedBy(appOutRoot, runtimeRoot) || runtimeRoot === appOutRoot) {
    throw new Error("[windows-cua-runtime-assets] runtime target escapes appOutDir");
  }
  const toolsRoot = dirname(runtimeRoot);
  await mkdir(toolsRoot, { recursive: true });
  const stagingRoot = resolve(toolsRoot, `.cua-helper-stage-${randomUUID()}`);
  if (!isPathContainedBy(toolsRoot, stagingRoot) || stagingRoot === toolsRoot) {
    throw new Error("[windows-cua-runtime-assets] staging target escapes tools directory");
  }

  await mkdir(stagingRoot);
  try {
    const runtime = await stageCuaRuntimeTree({
      targetPlatform: nodeTarget,
      zcodeCuaRoot,
      runtimeRoot: stagingRoot,
      dependencyPackageRoots,
      runtimeContractName: nodeTarget.os === "linux" ? "linux" : "windows",
    });

    // 清单从最终 staging 树枚举生成，避免新增 JS、package.json 或 native 旁文件时漏签。
    const files = await collectWindowsCuaRuntimeManifestFiles(await realpath(stagingRoot));
    const manifest = {
      schemaVersion: 1,
      packageName: runtime.packageName,
      packageVersion: runtime.packageVersion,
      platform: nodeTarget.os,
      arch: nodeTarget.arch,
      electronVersion,
      entry: runtime.entry,
      addon: runtime.addon,
      files,
    };
    await writeFile(
      resolve(stagingRoot, RUNTIME_MANIFEST_NAME),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );

    await rm(runtimeRoot, { force: true, recursive: true });
    await rename(stagingRoot, runtimeRoot);
    return {
      staged: true,
      runtimeRoot,
      runtimeModules: runtime.runtimeModules,
      nativePackageName: runtime.nativePackageName,
      manifest,
    };
  } catch (error) {
    await rm(stagingRoot, { force: true, recursive: true });
    throw error;
  }
}

/** Compatibility export for existing Windows-only build callers. */
export async function stageWindowsCuaRuntimeAssets(options) {
  if (options?.electronPlatformName !== "win32") return { staged: false };
  return stageCuaNodeRuntimeAssets(options);
}
