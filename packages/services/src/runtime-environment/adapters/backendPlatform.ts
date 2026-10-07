import { lstat, open, realpath, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

export type BackendPlatformName = "win32" | "darwin" | "linux";
export type BackendArch = "x64" | "arm64";
export type BackendLibc = "glibc" | "musl";

export interface BackendPlatform {
  platform: BackendPlatformName;
  arch: BackendArch;
  libc?: BackendLibc;
}

interface NodeProcessReport {
  header?: {
    glibcVersionRuntime?: unknown;
  };
}

function unsupportedHost(message: string): Error {
  return new Error(`tool backend host unsupported: ${message}`);
}

function detectLibc(): BackendLibc {
  const report = process.report?.getReport?.() as NodeProcessReport | undefined;
  if (!report?.header) {
    throw unsupportedHost("Node runtime report is unavailable for libc detection");
  }
  return typeof report.header.glibcVersionRuntime === "string" && report.header.glibcVersionRuntime
    ? "glibc"
    : "musl";
}

export function detectBackendPlatform(): BackendPlatform {
  const platform = process.platform;
  const arch = process.arch;
  if (platform !== "win32" && platform !== "darwin" && platform !== "linux") {
    throw unsupportedHost(`OS ${platform}`);
  }
  if (arch !== "x64" && arch !== "arm64") {
    throw unsupportedHost(`architecture ${arch}`);
  }
  return {
    platform,
    arch,
    ...(platform === "linux" ? { libc: detectLibc() } : {}),
  };
}

export function backendPlatformKey(platform: BackendPlatform): string {
  if (platform.platform === "linux") {
    if (!platform.libc) throw unsupportedHost("Linux libc is unknown");
    return `linux-${platform.arch}-${platform.libc}`.replace(/-glibc$/, "");
  }
  if (platform.platform === "win32") return `windows-${platform.arch}`;
  if (platform.platform === "darwin") return `macos-${platform.arch}`;
  throw unsupportedHost(`OS ${platform.platform}`);
}

export function backendExecutableName(platform: BackendPlatform): string {
  return platform.platform === "win32" ? "mise.exe" : "mise";
}

export function toolExecutableCandidates(key: "node" | "pnpm", platform: BackendPlatform): string[] {
  if (key === "node") return platform.platform === "win32" ? ["node.exe"] : ["bin/node"];
  // pnpm 原生分发与 JS 分发目录不同；.cmd 不能交给 execFile，直接定位其固定 JS payload。
  const scripts = ["bin/pnpm.cjs", "pnpm.cjs", "node_modules/pnpm/bin/pnpm.cjs", "lib/node_modules/pnpm/bin/pnpm.cjs"];
  return platform.platform === "win32" ? ["pnpm.exe", ...scripts] : [...scripts, "bin/pnpm", "pnpm"];
}

export async function isNodeLauncher(toolPath: string): Promise<boolean> {
  if (/\.(?:cjs|mjs|js)$/iu.test(toolPath)) return true;
  const file = await open(toolPath, "r");
  try {
    const buffer = Buffer.alloc(256);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return /^#![^\r\n]*\bnode(?:\s|$)/u.test(buffer.subarray(0, bytesRead).toString("utf8"));
  } finally {
    await file.close();
  }
}

export async function resolveToolExecutable(
  key: "node" | "pnpm",
  installRoot: string,
  platform: BackendPlatform,
): Promise<string> {
  const rootReal = await realpath(installRoot);
  for (const relativePath of toolExecutableCandidates(key, platform)) {
    const candidate = resolve(rootReal, relativePath);
    if (!isPathWithin(rootReal, candidate)) continue;
    const entry = await lstat(candidate).catch(() => undefined);
    if (!entry?.isFile() && !entry?.isSymbolicLink()) continue;
    const executable = await realpathWithin(rootReal, candidate);
    const target = await stat(executable);
    if (!target.isFile()) throw new Error(`managed ${key} executable is not a regular file: ${candidate}`);
    const script = key === "pnpm" && await isNodeLauncher(executable);
    if (!script && platform.platform !== "win32" && (target.mode & 0o111) === 0) {
      throw new Error(`managed ${key} executable is not executable: ${candidate}`);
    }
    return executable;
  }
  throw new Error(`mise installation has no supported ${key} executable under ${rootReal}`);
}

export async function realpathWithin(rootPath: string, candidatePath: string): Promise<string> {
  const root = await realpath(rootPath);
  const candidate = await realpath(candidatePath);
  if (!isPathWithin(root, candidate)) {
    throw new Error(`path escapes managed root: ${candidatePath}`);
  }
  return candidate;
}

export function isPathWithin(rootPath: string, candidatePath: string): boolean {
  const root = resolve(rootPath);
  const candidate = resolve(candidatePath);
  const relativePath = relative(root, candidate);
  if (relativePath === "") return true;
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`)) return false;
  return !relativePath.startsWith(sep) && !/^[A-Za-z]:[\\/]/u.test(relativePath);
}
