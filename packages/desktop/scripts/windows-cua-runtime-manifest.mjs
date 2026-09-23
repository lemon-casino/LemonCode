import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep, win32 as windowsPath } from "node:path";

const RUNTIME_MANIFEST_NAME = "runtime-manifest.json";

function isNonEmptyTrimmedString(value) {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function isPathContainedBy(root, candidate) {
  const relativePath = relative(root, candidate);
  return (
    relativePath === "" ||
    (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  );
}

export function compareCanonicalPaths(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function requireCanonicalWindowsRuntimePath(value, label) {
  if (
    !isNonEmptyTrimmedString(value) ||
    value.length > 4096 ||
    value.includes("\\") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    isAbsolute(value) ||
    windowsPath.isAbsolute(value) ||
    windowsPath.normalize(value).replaceAll("\\", "/") !== value ||
    value
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
      )
  ) {
    throw new Error(`[windows-cua-runtime-assets] ${label} must be a canonical relative path`);
  }
  return value;
}

async function requireContainedRegularFile(rootRealPath, relativePath) {
  const absolutePath = resolve(rootRealPath, ...relativePath.split("/"));
  const stats = await lstat(absolutePath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(
      `[windows-cua-runtime-assets] staged runtime asset must be a regular file: ${relativePath}`,
    );
  }
  const physicalPath = await realpath(absolutePath);
  if (!isPathContainedBy(rootRealPath, physicalPath)) {
    throw new Error(
      `[windows-cua-runtime-assets] staged runtime asset escapes its root: ${relativePath}`,
    );
  }
  return physicalPath;
}

async function requireContainedRegularDirectory(rootRealPath, directoryPath, relativeDirectory) {
  const stats = await lstat(directoryPath);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(
      `[windows-cua-runtime-assets] staged runtime directory must be regular: ${relativeDirectory}`,
    );
  }
  const physicalPath = await realpath(directoryPath);
  if (!isPathContainedBy(rootRealPath, physicalPath)) {
    throw new Error(
      `[windows-cua-runtime-assets] staged runtime directory escapes its root: ${relativeDirectory}`,
    );
  }
  return physicalPath;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function collectWindowsCuaRuntimeManifestFiles(rootRealPath, relativeDirectory = "") {
  const directoryPath = relativeDirectory
    ? resolve(rootRealPath, ...relativeDirectory.split("/"))
    : rootRealPath;
  const directoryRealPath = await requireContainedRegularDirectory(
    rootRealPath,
    directoryPath,
    relativeDirectory,
  );
  const entries = await readdir(directoryPath, { withFileTypes: true });
  entries.sort((left, right) => compareCanonicalPaths(left.name, right.name));
  const files = [];
  const seenWindowsNames = new Set();

  for (const entry of entries) {
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    requireCanonicalWindowsRuntimePath(relativePath, `staged runtime asset ${relativePath}`);
    if (seenWindowsNames.has(entry.name.toLowerCase())) {
      throw new Error(
        `[windows-cua-runtime-assets] staged runtime contains a case-colliding path: ${relativePath}`,
      );
    }
    seenWindowsNames.add(entry.name.toLowerCase());
    if (entry.isSymbolicLink()) {
      throw new Error(
        `[windows-cua-runtime-assets] staged runtime contains a symlink: ${relativePath}`,
      );
    }
    if (entry.isDirectory()) {
      files.push(...(await collectWindowsCuaRuntimeManifestFiles(rootRealPath, relativePath)));
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(
        `[windows-cua-runtime-assets] staged runtime contains a non-file asset: ${relativePath}`,
      );
    }
    if (relativePath === RUNTIME_MANIFEST_NAME) {
      throw new Error("[windows-cua-runtime-assets] staging root already contains a manifest");
    }
    const physicalPath = await requireContainedRegularFile(rootRealPath, relativePath);
    files.push({ path: relativePath, sha256: sha256(await readFile(physicalPath)) });
  }

  const stableDirectoryRealPath = await requireContainedRegularDirectory(
    rootRealPath,
    directoryPath,
    relativeDirectory,
  );
  if (windowsPath.normalize(directoryRealPath) !== windowsPath.normalize(stableDirectoryRealPath)) {
    throw new Error(
      `[windows-cua-runtime-assets] staged runtime directory changed while hashing: ${relativeDirectory}`,
    );
  }

  return files.sort((left, right) => compareCanonicalPaths(left.path, right.path));
}
