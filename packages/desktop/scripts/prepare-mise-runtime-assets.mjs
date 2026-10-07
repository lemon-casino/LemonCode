#!/usr/bin/env node

import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import { tsImport } from "tsx/esm/api";
import {
  resolveMiseCacheDir,
  validateMiseBuildProvenance,
} from "../../../scripts/mise-build-provenance.mjs";

const desktopRoot = resolve(import.meta.dirname, "..");
const workspaceRoot = resolve(desktopRoot, "../..");
const backendArchivePath = resolve(
  workspaceRoot,
  "packages/services/src/runtime-environment/adapters/backendArchive.ts",
);
const DEFAULT_MISE_LIBC = "glibc";
const SUPPORTED_LIBCS = new Set(["glibc", "musl"]);
export const MISE_VERSION = "v2026.10.2";

let backendApiPromise;

function normalizeTargetOs(rawOs) {
  const value = String(rawOs ?? "").toLowerCase();
  if (["win", "windows", "win32"].includes(value)) return "win32";
  if (["mac", "macos", "darwin", "osx"].includes(value)) return "darwin";
  if (value === "linux") return "linux";
  throw new Error(`Unsupported mise target OS: ${rawOs}`);
}

function normalizeTargetArch(rawArch) {
  const value = String(rawArch ?? "").toLowerCase();
  if (["x64", "amd64", "x86_64"].includes(value)) return "x64";
  if (["arm64", "aarch64"].includes(value)) return "arm64";
  throw new Error(`Unsupported mise target arch: ${rawArch}`);
}

function normalizeLibc(rawLibc, os) {
  if (os !== "linux") {
    if (rawLibc !== undefined && rawLibc !== "") {
      throw new Error(`mise libc is only supported for Linux targets: ${rawLibc}`);
    }
    return undefined;
  }
  const libc = String(rawLibc || DEFAULT_MISE_LIBC).toLowerCase();
  if (!SUPPORTED_LIBCS.has(libc)) {
    throw new Error(`Unsupported mise Linux libc: ${rawLibc}`);
  }
  return libc;
}

function backendPlatformKey(platform) {
  if (platform.os === "win32") return `windows-${platform.arch}`;
  if (platform.os === "darwin") return `macos-${platform.arch}`;
  return `linux-${platform.arch}${platform.libc === "musl" ? "-musl" : ""}`;
}

export function resolveMiseTarget({ os, arch, libc } = {}) {
  const targetOs = normalizeTargetOs(os ?? process.env.LCODE_TARGET_OS ?? process.platform);
  const targetArch = normalizeTargetArch(arch ?? process.env.LCODE_TARGET_ARCH ?? process.arch);
  const targetLibc = normalizeLibc(
    libc ?? process.env.LCODE_MISE_LIBC ?? process.env.LCODE_TARGET_LIBC,
    targetOs,
  );
  const desktopTargetKey = `${targetOs}-${targetArch}`;
  const backendPlatform = {
    platform: targetOs,
    arch: targetArch,
    ...(targetLibc ? { libc: targetLibc } : {}),
  };
  return {
    os: targetOs,
    arch: targetArch,
    libc: targetLibc,
    key: desktopTargetKey,
    desktopTargetKey,
    backendKey: backendPlatformKey({ os: targetOs, arch: targetArch, libc: targetLibc }),
    backendPlatform,
  };
}

export function parseMiseArgs(argv = process.argv.slice(2), env = process.env) {
  const options = {
    os: env.LCODE_TARGET_OS,
    arch: env.LCODE_TARGET_ARCH,
    libc: env.LCODE_MISE_LIBC ?? env.LCODE_TARGET_LIBC,
    cacheDir: env.LCODE_MISE_CACHE_DIR,
    skip: env.LCODE_SKIP_MISE_PREPARE === "1",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--skip" || arg === "--skip-prepare") {
      options.skip = true;
      continue;
    }
    if (arg === "--os" || arg === "-o") {
      options.os = argv[++index];
      continue;
    }
    if (arg.startsWith("--os=")) {
      options.os = arg.slice("--os=".length);
      continue;
    }
    if (arg === "--arch" || arg === "-a") {
      options.arch = argv[++index];
      continue;
    }
    if (arg.startsWith("--arch=")) {
      options.arch = arg.slice("--arch=".length);
      continue;
    }
    if (arg === "--libc") {
      options.libc = argv[++index];
      continue;
    }
    if (arg.startsWith("--libc=")) {
      options.libc = arg.slice("--libc=".length);
      continue;
    }
    if (arg === "--cache-dir") {
      options.cacheDir = argv[++index];
      continue;
    }
    if (arg.startsWith("--cache-dir=")) {
      options.cacheDir = arg.slice("--cache-dir=".length);
      continue;
    }
    if (arg === "--desktop-root") {
      options.desktopRoot = argv[++index];
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      return { ...options, help: true };
    }
    throw new Error(`Unsupported mise preparation argument: ${arg}`);
  }
  return options;
}

export async function loadBackendArchiveApi() {
  backendApiPromise ??= tsImport(pathToFileURL(backendArchivePath).href, import.meta.url);
  const api = await backendApiPromise;
  if (typeof api.downloadAndPublishBackend !== "function") {
    throw new Error("backendArchive.ts does not export downloadAndPublishBackend");
  }
  if (typeof api.validateBundledBackend !== "function") {
    throw new Error("backendArchive.ts does not export validateBundledBackend");
  }
  return api;
}

function targetRootFor(root, target) {
  return resolve(root, "bundled-tools", target.desktopTargetKey, "mise");
}

export function resolveMiseBundledRoot(root = desktopRoot, target = resolveMiseTarget()) {
  return targetRootFor(root, target);
}

export function resolveMisePackagedRoot(resourcesDir) {
  return resolve(resourcesDir, "tools", "mise");
}

export function resolveMiseExtraResource(target = resolveMiseTarget()) {
  return {
    from: `bundled-tools/${target.desktopTargetKey}/mise`,
    to: "tools/mise",
    filter: ["**/*"],
  };
}

function expectedArchiveSha256(api, target) {
  const digest = api.MISE_ASSET_DIGESTS?.[target.backendKey];
  if (!digest)
    throw new Error(`backendArchive.ts has no fixed mise digest for ${target.backendKey}`);
  return digest;
}

async function validateRoot({ root, target, api }) {
  return api.validateBundledBackend(root, {
    version: api.MISE_BACKEND_VERSION ?? MISE_VERSION,
    platform: target.backendPlatform,
    archiveSha256: expectedArchiveSha256(api, target),
  });
}

export async function validateMiseRuntimeAssets({
  root = desktopRoot,
  desktopRoot: explicitDesktopRoot,
  target = resolveMiseTarget(),
  backendApi,
  cacheDir,
} = {}) {
  const resolvedDesktopRoot = explicitDesktopRoot ?? root;
  const api = backendApi ?? (await loadBackendArchiveApi());
  const bundledRoot = targetRootFor(resolvedDesktopRoot, target);
  const validated = await validateRoot({ root: bundledRoot, target, api });
  await validateMiseBuildProvenance({ root: bundledRoot, target, backendApi: api, cacheDir });
  return {
    ...validated,
    root: bundledRoot,
    target,
    backendKey: target.backendKey,
  };
}

export const verifyMiseRuntimeAssets = validateMiseRuntimeAssets;

export async function validatePackagedMiseRuntimeAssets({
  resourcesDir,
  target = resolveMiseTarget(),
  backendApi,
} = {}) {
  if (!resourcesDir) throw new Error("resourcesDir is required to validate packaged mise");
  const api = backendApi ?? (await loadBackendArchiveApi());
  const root = resolveMisePackagedRoot(resourcesDir);
  const validated = await validateRoot({ root, target, api });
  return { ...validated, root, target, backendKey: target.backendKey };
}

export function resolveMacMisePresignInput({ appOutDir, appName }) {
  if (!appOutDir || !appName)
    throw new Error("appOutDir and appName are required for mise presign input");
  return resolve(appOutDir, appName, "Contents", "Resources", "tools", "mise");
}

export async function prepareMiseRuntimeAssets({
  root = desktopRoot,
  desktopRoot: explicitDesktopRoot,
  target = resolveMiseTarget(),
  skip = process.env.LCODE_SKIP_MISE_PREPARE === "1",
  cacheDir,
  backendApi,
} = {}) {
  const resolvedDesktopRoot = explicitDesktopRoot ?? root;
  const api = backendApi ?? (await loadBackendArchiveApi());
  const bundledRoot = targetRootFor(resolvedDesktopRoot, target);
  try {
    return {
      ...(await validateMiseRuntimeAssets({
        desktopRoot: resolvedDesktopRoot,
        target,
        backendApi: api,
        cacheDir,
      })),
      reused: true,
    };
  } catch (error) {
    if (skip) {
      throw new Error(
        `mise runtime asset is missing or invalid for ${target.desktopTargetKey}; --skip only accepts a validated cache: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  const bundledToolsRoot = resolve(resolvedDesktopRoot, "bundled-tools");
  await mkdir(bundledToolsRoot, { recursive: true });
  const stagingParent = await mkdtemp(join(bundledToolsRoot, `.mise-stage-${process.pid}-`));
  try {
    const publishedRoot = join(stagingParent, "published");
    await api.downloadAndPublishBackend({
      platform: target.backendPlatform,
      destinationRoot: publishedRoot,
      cacheRoot: resolveMiseCacheDir(cacheDir),
    });
    const sourceRoot = resolve(
      publishedRoot,
      api.MISE_BACKEND_VERSION ?? MISE_VERSION,
      target.backendKey,
    );
    await validateRoot({ root: sourceRoot, target, api });
    await validateMiseBuildProvenance({ root: sourceRoot, target, backendApi: api, cacheDir });
    await mkdir(dirname(bundledRootForSibling(bundledToolsRoot, target)), { recursive: true });
    await rm(bundledRootForSibling(bundledToolsRoot, target), { recursive: true, force: true });
    await rename(sourceRoot, bundledRootForSibling(bundledToolsRoot, target));
    return {
      ...(await validateRoot({ root: bundledRoot, target, api })),
      root: bundledRoot,
      target,
      backendKey: target.backendKey,
      reused: false,
    };
  } finally {
    await rm(stagingParent, { recursive: true, force: true });
  }
}

function bundledRootForSibling(bundledToolsRoot, target) {
  return join(bundledToolsRoot, target.desktopTargetKey, "mise");
}

export async function prepareMiseFromArgs(argv = process.argv.slice(2), env = process.env) {
  const options = parseMiseArgs(argv, env);
  if (options.help) {
    console.log(
      "Usage: node scripts/prepare-mise-runtime-assets.mjs [--skip] [--os win32|darwin|linux] [--arch x64|arm64] [--libc glibc|musl] [--cache-dir path] [--desktop-root path]",
    );
    return null;
  }
  const target = resolveMiseTarget(options);
  return prepareMiseRuntimeAssets({
    target,
    skip: options.skip,
    cacheDir: options.cacheDir,
    desktopRoot: options.desktopRoot,
  });
}

const entryHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entryHref === import.meta.url) {
  try {
    const result = await prepareMiseFromArgs();
    if (result) {
      console.log(
        `[prepare:mise] ${result.reused ? "validated" : "prepared"} ${result.target.desktopTargetKey} -> ${result.backendPath}`,
      );
    }
  } catch (error) {
    console.error(`[prepare:mise] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
