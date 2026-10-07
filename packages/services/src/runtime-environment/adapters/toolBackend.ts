import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { maxSatisfying, valid, validRange } from "semver";
import { withFileLock } from "@lcode/shared/node";
import type { ToolBackendPort } from "../app/ports.js";
import {
  backendExecutableName,
  backendPlatformKey,
  detectBackendPlatform,
  isPathWithin,
  isNodeLauncher,
  realpathWithin,
  resolveToolExecutable,
  toolExecutableCandidates,
  type BackendPlatform,
} from "./backendPlatform.js";
import {
  MISE_BACKEND_VERSION,
  MISE_ASSET_DIGESTS,
  validateBundledBackend,
} from "./backendArchive.js";

import {
  BACKEND_COMMAND_TIMEOUT_MS,
  runBackendCommand as runAbsoluteCommand,
  throwIfBackendAborted as throwIfAborted,
} from "./backendCommand.js";
const EXACT_SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const SUPPORTED_TOOLS = new Set(["node", "pnpm"]);
/**
 * 工具后端 port 与构建期绑定的便携 mise 适配（spec §5/§9.4）。
 * 后端资产由应用构建产物提供；运行时只验证该绝对路径，不下载、不回退 PATH。
 * 后端版本、平台、配置目录和工具 allowlist 都由本适配器固定，项目 cwd 与未审核 MISE_* 不参与执行。
 */

export interface ToolBackendOptions {
  /** HostDataRoot 下 runtime-environments 数据目录（tool-backends/tool-store 同级）。 */
  dataDir: string;
  /** 构建期随应用提供的绝对 mise 可执行文件路径。 */
  backendPath?: string;
  /** Host 注入的受控网络 transport；仅用于工具安装与范围版本查询。 */
  fetch?: typeof globalThis.fetch;
  /** Host 注入的受控网络环境；只用于 mise 子进程，不能由 fetch 替代。 */
  resolveEnv?: () => Promise<NodeJS.ProcessEnv>;
  /** 测试/打包校验使用的平台覆盖；生产默认读取当前 Node 平台。 */
  platform?: BackendPlatform;
  fetchTimeoutMs?: number;
}

export interface ToolVersionResolutionParams {
  key: string;
  constraint: string;
  signal?: AbortSignal;
}

export interface ToolInstallParams {
  key: string;
  version: string;
  /** pnpm 必须使用同一冻结计划已安装的受管 Node，不借宿主 Node。 */
  nodePath?: string;
  signal?: AbortSignal;
}

/** 固定后端版本与官方资产摘要（由 backendArchive 维护单一常量源）。 */
export { MISE_BACKEND_VERSION, MISE_ASSET_DIGESTS } from "./backendArchive.js";
function backendError(message: string): Error {
  return new Error(`tool backend unavailable: ${message}`);
}

function validateToolKey(key: string): "node" | "pnpm" {
  if (!SUPPORTED_TOOLS.has(key)) {
    throw new Error(`unsupported managed tool: ${key}`);
  }
  return key as "node" | "pnpm";
}

function exactVersion(version: string): string {
  if (!EXACT_SEMVER.test(version) || valid(version) !== version) {
    throw new Error(`managed tool version must be an exact semver: ${version}`);
  }
  return version;
}

function isExactVersion(value: string): boolean {
  return EXACT_SEMVER.test(value) && valid(value) === value;
}

function miseArgs(...args: string[]): string[] {
  return ["--no-config", ...args];
}

function lastOutputLine(output: string): string {
  const lines = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.at(-1) ?? "";
}

function parseRemoteVersions(output: string): string[] {
  const trimmed = output.trim();
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start < 0 || end <= start) throw new Error("mise ls-remote returned invalid JSON");
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1));
  } catch (error) {
    throw new Error(`mise ls-remote returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(parsed)) throw new Error("mise ls-remote returned a non-array result");
  const versions: string[] = [];
  for (const item of parsed) {
    const value = typeof item === "string" ? item : item && typeof item === "object" && "version" in item ? item.version : undefined;
    if (typeof value === "string" && valid(value) === value) versions.push(value);
  }
  return [...new Set(versions)];
}

function samePath(left: string, right: string, platform: BackendPlatform): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return platform.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function createToolBackend(options: ToolBackendOptions): ToolBackendPort & {
  resolveVersion(params: ToolVersionResolutionParams): Promise<string>;
} {
  const root = resolve(options.dataDir);
  const platformResult: BackendPlatform | Error = options.platform ?? (() => {
    try {
      return detectBackendPlatform();
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  })();
  const platform = platformResult instanceof Error ? undefined : platformResult;
  const platformFailure = platformResult instanceof Error ? platformResult : undefined;
  const fixedBackendPath = options.backendPath
    ? isAbsolute(options.backendPath)
      ? resolve(options.backendPath)
      : undefined
    : undefined;
  const backendPathFailure = options.backendPath && !fixedBackendPath
    ? backendError("backendPath must be an absolute path")
    : undefined;
  const platformKey = platform ? backendPlatformKey(platform) : undefined;
  const backendStoreRoot = platformKey
    ? join(root, "tool-store", "mise", MISE_BACKEND_VERSION, platformKey)
    : undefined;
  const toolStoreDir = backendStoreRoot;
  const miseDataDir = backendStoreRoot ? join(backendStoreRoot, "data") : undefined;
  const miseConfigDir = backendStoreRoot ? join(backendStoreRoot, "config") : undefined;
  const miseCacheDir = backendStoreRoot ? join(backendStoreRoot, "cache") : undefined;

  function requirePlatform(): BackendPlatform {
    if (platformFailure) throw backendError(platformFailure.message);
    if (!platform) throw backendError("host platform is unavailable");
    return platform;
  }

  function requireBackendPath(): string {
    requirePlatform();
    if (backendPathFailure) throw backendPathFailure;
    if (!fixedBackendPath) {
      throw backendError("the bundled mise backend is missing; runtime download is disabled");
    }
    const expectedName = backendExecutableName(requirePlatform());
    if (fixedBackendPath.toLowerCase().endsWith("/") || fixedBackendPath.toLowerCase().endsWith("\\")) {
      throw backendError("backendPath must name the bundled executable");
    }
    if (fixedBackendPath.split(/[\\/]/u).at(-1)?.toLowerCase() !== expectedName.toLowerCase()) {
      throw backendError(`backendPath must end with ${expectedName}`);
    }
    return fixedBackendPath;
  }

  async function dataEnv(nodePath?: string): Promise<NodeJS.ProcessEnv> {
    if (!miseDataDir || !miseConfigDir || !miseCacheDir) throw backendError("host platform is unavailable");
    await Promise.all([
      mkdir(miseDataDir, { recursive: true }),
      mkdir(miseConfigDir, { recursive: true }),
      mkdir(miseCacheDir, { recursive: true }),
    ]);
    const resolved = options.resolveEnv ? await options.resolveEnv() : process.env;
    const env: NodeJS.ProcessEnv = {};
    let inheritedPath: string | undefined;
    for (const [key, value] of Object.entries(resolved)) {
      const normalized = key.toUpperCase();
      // Windows 环境键不区分大小写；旧逻辑会保留 Path/混合大小写 MISE_*，绕过冻结覆盖。
      // NODE_OPTIONS/NODE_PATH 也不能把宿主预加载脚本或模块解析带进受管版本验证。
      if (normalized === "PATH") inheritedPath = value;
      else if (!normalized.startsWith("MISE_") && normalized !== "NODE_OPTIONS" && normalized !== "NODE_PATH" && value !== undefined) env[key] = value;
    }
    if (nodePath) {
      const delimiter = requirePlatform().platform === "win32" ? ";" : ":";
      env.PATH = [dirname(nodePath), inheritedPath].filter(Boolean).join(delimiter);
    } else if (inheritedPath !== undefined) env.PATH = inheritedPath;
    return {
      ...env,
      MISE_DATA_DIR: miseDataDir,
      MISE_CONFIG_DIR: miseConfigDir,
      MISE_CACHE_DIR: miseCacheDir,
      MISE_NO_CONFIG: "1",
    };
  }
  async function verifyBackend(signal?: AbortSignal): Promise<string> {
    const currentPlatform = requirePlatform();
    const executable = requireBackendPath();
    const entry = await lstat(executable).catch((error) => {
      throw backendError(`bundled mise backend is missing: ${error instanceof Error ? error.message : String(error)}`);
    });
    if (!entry.isFile()) throw backendError("bundled mise backend is not a regular file");
    const resolved = await realpath(executable);
    const root = resolve(dirname(executable), "..");
    await validateBundledBackend(root, {
      version: MISE_BACKEND_VERSION,
      platform: currentPlatform,
      archiveSha256: MISE_ASSET_DIGESTS[backendPlatformKey(currentPlatform)],
    });
    const result = await runAbsoluteCommand(executable, miseArgs("version"), await dataEnv(), { signal });
    if (result.code !== 0) {
      throw backendError(`bundled mise version probe failed: ${result.stderr.slice(-2000)}`);
    }
    const expectedVersion = MISE_BACKEND_VERSION.slice(1);
    const expectedPlatform = backendPlatformKey(currentPlatform);
    const versionLine = result.stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => new RegExp(`^${expectedVersion.replaceAll(".", "\\.")}\\s+${expectedPlatform}(?:\\s|$)`, "u").test(line));
    if (!versionLine) {
      throw backendError(`bundled mise version/platform mismatch; expected ${expectedVersion} ${expectedPlatform}`);
    }
    return resolved;
  }

  async function ensureBackend(): Promise<string> {
    return verifyBackend();
  }

  async function resolveVersion(params: ToolVersionResolutionParams): Promise<string> {
    const key = validateToolKey(params.key);
    const constraint = params.constraint.trim();
    if (!constraint) throw new Error(`managed tool version constraint is empty for ${key}`);
    throwIfAborted(params.signal);
    await verifyBackend(params.signal);
    if (isExactVersion(constraint)) return constraint;
    const range = validRange(constraint);
    // 原始空值已拒绝；标准 semver 的显式通配范围必须交给一次版本列表查询冻结。
    if (range === null) {
      throw new Error(`unsupported managed tool version constraint for ${key}: ${constraint}`);
    }
    const result = await runAbsoluteCommand(
      requireBackendPath(),
      miseArgs("ls-remote", key, "--json"),
      await dataEnv(),
      { signal: params.signal },
    );
    if (result.code !== 0) {
      throw new Error(`mise ls-remote ${key} failed: ${result.stderr.slice(-2000)}`);
    }
    const selected = maxSatisfying(parseRemoteVersions(result.stdout), range);
    if (!selected) {
      throw new Error(`no ${key} version satisfies ${constraint}`);
    }
    return selected;
  }

  async function queryInstallRoot(key: "node" | "pnpm", version: string, signal?: AbortSignal, nodePath?: string): Promise<string> {
    const result = await runAbsoluteCommand(
      requireBackendPath(),
      miseArgs("where", `${key}@${version}`),
      await dataEnv(nodePath),
      { signal },
    );
    if (result.code !== 0) throw new Error(`mise where ${key}@${version} failed: ${result.stderr.slice(-2000)}`);
    const candidate = lastOutputLine(result.stdout);
    if (!candidate || !isAbsolute(candidate)) {
      throw new Error(`mise where ${key}@${version} returned a non-absolute path`);
    }
    if (!miseDataDir || !toolStoreDir) throw backendError("tool store is unavailable on this host");
    const managedRoot = join(miseDataDir, "installs", key, version);
    const managedRootReal = await realpath(managedRoot);
    const candidateReal = await realpathWithin(managedRootReal, candidate);
    if (!samePath(managedRootReal, candidateReal, requirePlatform())) {
      throw new Error(`mise where ${key}@${version} escaped its managed installation root`);
    }
    return candidateReal;
  }

  async function verifyToolVersion(
    key: "node" | "pnpm",
    version: string,
    toolPath: string,
    signal?: AbortSignal,
    nodePath?: string,
  ): Promise<void> {
    const script = key === "pnpm" && await isNodeLauncher(toolPath);
    if (script && !nodePath) throw new Error("pnpm requires a frozen nodePath");
    // 根因：直接 execFile .cjs/.cmd 在 Windows 失败，Unix shebang 又会借 PATH 上的 Node。
    // 脚本显式交给冻结 Node；原生 pnpm 则保留原生入口并固定其子进程 PATH。
    const result = await runAbsoluteCommand(
      script ? nodePath! : toolPath,
      script ? [toolPath, "--version"] : ["--version"],
      await dataEnv(nodePath),
      { signal, timeoutMs: 120_000 },
    );
    if (result.code !== 0) throw new Error(`${key} --version failed: ${result.stderr.slice(-2000)}`);
    const actual = lastOutputLine(result.stdout);
    const expected = key === "node" ? `v${version}` : version;
    if (actual !== expected) {
      throw new Error(`${key} version mismatch: expected ${expected}, got ${actual || "<empty>"}`);
    }
  }

  async function requireFrozenNode(nodePath: string | undefined, signal?: AbortSignal): Promise<string> {
    if (!nodePath || !isAbsolute(nodePath)) throw new Error("pnpm requires an absolute frozen nodePath");
    if (!miseDataDir || !toolStoreDir) throw backendError("tool store is unavailable on this host");
    const versionsRoot = await realpathWithin(toolStoreDir, join(miseDataDir, "installs", "node"));
    if (!isPathWithin(versionsRoot, nodePath)) throw new Error("pnpm nodePath is outside the managed Node store");
    const canonical = await realpathWithin(versionsRoot, nodePath);
    const version = relative(versionsRoot, canonical).split(sep)[0];
    if (!version || !isExactVersion(version)) throw new Error("pnpm nodePath has no frozen managed Node version");
    const expected = join(versionsRoot, version, toolExecutableCandidates("node", requirePlatform())[0]!);
    if (!samePath(expected, canonical, requirePlatform()) || !(await lstat(canonical)).isFile()) {
      throw new Error("pnpm nodePath is not the frozen managed Node executable");
    }
    await verifyToolVersion("node", version, canonical, signal, canonical);
    return canonical;
  }

  async function installTool(params: ToolInstallParams): Promise<{ toolPath: string }> {
    const key = validateToolKey(params.key);
    const version = exactVersion(params.version);
    throwIfAborted(params.signal);
    const nodePath = key === "pnpm" ? await requireFrozenNode(params.nodePath, params.signal) : undefined;
    await verifyBackend(params.signal);
    if (!toolStoreDir || !miseDataDir) throw backendError("tool store is unavailable on this host");
    const lockName = `${platformKey}-${key}-${version}`.replace(/[^A-Za-z0-9._-]/gu, "_");
    let toolPath: string | undefined;
    await withFileLock(join(toolStoreDir, `${lockName}.lock`), async () => {
      throwIfAborted(params.signal);
      const cached = await lstat(join(miseDataDir, "installs", key, version)).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      // 根因：即便确切版本已缓存，mise install 仍会联网查索引；同锁内验证缓存后直接复用。
      // 已有目录损坏必须失败，不能重装覆盖或放宽路径/版本校验；仅缺失版本走安装。
      if (!cached) {
        const result = await runAbsoluteCommand(
          requireBackendPath(), miseArgs("install", `${key}@${version}`),
          await dataEnv(nodePath), { signal: params.signal },
        );
        if (result.code !== 0) throw new Error(`mise install ${key}@${version} failed: ${result.stderr.slice(-2000)}`);
      }
      const installRoot = await queryInstallRoot(key, version, params.signal, nodePath);
      const executable = await resolveToolExecutable(key, installRoot, requirePlatform());
      await verifyToolVersion(key, version, executable, params.signal, nodePath);
      throwIfAborted(params.signal);
      toolPath = executable;
    }, {
      // 首次工具下载通常超过共享文件写入锁的 8 秒默认值；仍按活 owner 互斥，不按时间抢锁。
      lockMaxWaitMs: BACKEND_COMMAND_TIMEOUT_MS + 240_000,
    });
    if (!toolPath) throw new Error(`mise install ${key}@${version} produced no tool path`);
    return { toolPath };
  }

  const backend: ToolBackendPort & {
    resolveVersion(params: ToolVersionResolutionParams): Promise<string>;
  } = {
    ensureBackend,
    installTool,
    resolveVersion,
    async probeBackend() {
      try {
        await verifyBackend();
        return { available: true };
      } catch (error) {
        return {
          available: false,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
  return backend;
}
