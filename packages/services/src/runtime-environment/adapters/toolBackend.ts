import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { join, resolve } from "node:path";
import { withFileLock } from "@lcode/shared/node";
import type { ToolBackendPort } from "../app/ports.js";

/**
 * 工具后端 port 与便携 mise 适配（spec: specs/worktree-runtime-environments.md §5/§9.4）。
 * 后端版本与资产摘要固定（ADR §5.4）；--no-config 阻断项目/父级/全局配置注入（P0-03 实测）。
 * 同 key 跨进程互斥；离线明确失败不静默用 PATH 兜底；完整性失败隔离不发布。
 */

export interface ToolBackendOptions {
  /** HostDataRoot 下 runtime-environments 数据目录（tool-backends/tool-store 同级）。 */
  dataDir: string;
  /** 进程内下载互斥；跨进程锁由 store.lock 承担。 */
  fetchTimeoutMs?: number;
}

/** 固定后端版本与官方资产 sha256（ADR §5.4，2026-10-05 实测清单）。 */
export const MISE_BACKEND_VERSION = "v2026.10.2";
export const MISE_ASSET_DIGESTS: Readonly<Record<string, string>> = {
  "windows-x64": "6ce4281dc65a4dc22de2aed42db5e8859293a467964763b43fcc33fa0e6c4214",
  "windows-arm64": "9c4abb29dc88d956f5d6f2e468bade7843c9e3242690a9dbb22b2bbac4d007be",
  "macos-x64": "b8b23b39a05f1b36ebb49c5c556d549585f7e4b2d05ba9ff7c09bb026bf0fca7",
  "macos-arm64": "11df20cfebb7f52eb5c6f68c367eadc6cf22aca169566a8f5b2fa92bf1564540",
  "linux-x64": "a5f2082b6694c6f27e6a528e55dfb5983998a4d73004d003dfbf03406b938d49",
  "linux-x64-musl": "e35412ea4e944f959cccfa5826d6f860a08417a00dc023579cab3561c5a72fa3",
  "linux-arm64": "2df2ecffe694802cae43865fe11b932db361a902b7d4c4726fb4aaaa2d6a2396",
  "linux-arm64-musl": "32d89cc197a92016c7285c4fbdf067919b44097b7da65ff5722a3bc55b1cf793",
};

/** 全平台资产清单（ADR §5.4 全平台口径）；win/mac/linux × x64/arm64。 */
export const MISE_ASSETS: Readonly<Record<string, string>> = {
  "windows-x64": "mise-v2026.10.2-windows-x64.zip",
  "windows-arm64": "mise-v2026.10.2-windows-arm64.zip",
  "macos-x64": "mise-v2026.10.2-macos-x64.tar.xz",
  "macos-arm64": "mise-v2026.10.2-macos-arm64.tar.xz",
  "linux-x64": "mise-v2026.10.2-linux-x64.tar.xz",
  "linux-x64-musl": "mise-v2026.10.2-linux-x64-musl.tar.xz",
  "linux-arm64": "mise-v2026.10.2-linux-arm64.tar.xz",
  "linux-arm64-musl": "mise-v2026.10.2-linux-arm64-musl.tar.xz",
};

function platformKey(): string {
  const os = process.platform;
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  if (os === "win32") return `windows-${arch}`;
  if (os === "darwin") return `macos-${arch}`;
  // glibc/musl 区分不引入运行时探测 API；按环境变量显式覆盖，默认 glibc。
  return process.env.LCODE_MISE_MUSL === "1" ? `linux-${arch}-musl` : `linux-${arch}`;
}

function miseArgs(...args: string[]): string[] {
  return ["--no-config", ...args];
}

export function createToolBackend(options: ToolBackendOptions): ToolBackendPort {
  const root = resolve(options.dataDir);
  const backendsDir = join(root, "tool-backends", MISE_BACKEND_VERSION, platformKey());
  const toolStoreDir = join(root, "tool-store", "mise", MISE_BACKEND_VERSION);

  function backendExePath(): string {
    return process.platform === "win32"
      ? join(backendsDir, "bin", "mise.exe")
      : join(backendsDir, "bin", "mise");
  }

  function dataEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      MISE_DATA_DIR: join(root, "tool-store", "mise", MISE_BACKEND_VERSION, "data"),
      MISE_CONFIG_DIR: join(root, "tool-store", "mise", MISE_BACKEND_VERSION, "config"),
      MISE_NO_CONFIG: "1",
    };
  }

  function runMise(args: string[], timeoutMs: number): Promise<{ code: number; stderr: string }> {
    return new Promise((resolvePromise, rejectPromise) => {
      execFile(
        backendExePath(),
        miseArgs(...args),
        { env: dataEnv(), timeout: timeoutMs, windowsHide: true },
        (error, _stdout, stderr) => {
          if (error && typeof (error as NodeJS.ErrnoException).code === "string") {
            // spawn 失败（后端缺失/权限）直接拒绝，调用方转 capability/download 错误。
            rejectPromise(error);
            return;
          }
          resolvePromise({ code: error ? 1 : 0, stderr: String(stderr ?? "") });
        },
      );
    });
  }

  async function runMiseExit(args: string[], timeoutMs: number): Promise<{ code: number; stderr: string }> {
    try {
      return await runMise(args, timeoutMs);
    } catch (error) {
      return { code: 127, stderr: error instanceof Error ? error.message : String(error) };
    }
  }

  async function sha256File(path: string): Promise<string> {
    return createHash("sha256").update(await readFile(path)).digest("hex");
  }

  async function downloadAsset(dest: string): Promise<void> {
    const assetName = MISE_ASSETS[platformKey()];
    if (!assetName) throw new Error(`No mise asset for platform ${platformKey()}`);
    const url = `https://github.com/jdx/mise/releases/download/${MISE_BACKEND_VERSION}/${assetName}`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(options.fetchTimeoutMs ?? 600_000),
    });
    if (!response.ok || !response.body)
      throw new Error(`mise asset download failed: HTTP ${response.status}`);
    await pipeline(response.body, createWriteStream(dest));
  }

  async function ensureBackend(): Promise<string> {
    const exe = backendExePath();
    try {
      await stat(exe);
      return exe;
    } catch {
      // 后端缺失时下载；跨进程互斥按 backend key，坏产物隔离不发布。
    }
    await mkdir(join(root, "tool-backends", MISE_BACKEND_VERSION), { recursive: true });
    await withFileLock(
      join(root, "tool-backends", `${MISE_BACKEND_VERSION.replace(/[^a-zA-Z0-9.-]/g, "_")}.lock`),
      async () => {
        try {
          await stat(exe);
          return;
        } catch {
          // 双重检查：拿到锁后别人可能已装好。
        }
        const staging = join(backendsDir, `staging-${Date.now()}`);
        const assetPath = `${staging}.asset`;
        try {
          await mkdir(staging, { recursive: true });
          await downloadAsset(assetPath);
          const digest = await sha256File(assetPath);
          const expected = MISE_ASSET_DIGESTS[platformKey()];
          if (digest !== expected)
            throw new Error(`mise asset digest mismatch: got ${digest}, want ${expected}`);
          await extractArchive(assetPath, staging);
          await rename(staging, backendsDir);
        } catch (error) {
          await rm(staging, { recursive: true, force: true });
          await rm(assetPath, { force: true });
          throw error;
        }
      },
    );
    return exe;
  }

  async function extractArchive(assetPath: string, staging: string): Promise<void> {
    // 跨平台解压：zip 用 PowerShell Expand-Archive；tar.xz 用系统 tar（win10+ 自带 bsdtar）。
    if (assetPath.endsWith(".zip")) {
      await runExternal("powershell", [
        "-NoProfile",
        "-Command",
        `Expand-Archive -LiteralPath '${assetPath}' -DestinationPath '${staging}' -Force`,
      ]);
    } else {
      await runExternal("tar", ["-xf", assetPath, "-C", staging]);
    }
    // 资产解压出 mise-<ver>/ 前缀目录时展平到 staging。
    const entries = await readdir(staging, { withFileTypes: true });
    if (entries.length === 1 && entries[0]?.isDirectory()) {
      const inner = join(staging, entries[0].name);
      const innerEntries = await readdir(inner, { withFileTypes: true });
      for (const entry of innerEntries) {
        await rename(join(inner, entry.name), join(staging, entry.name));
      }
      await rm(inner, { recursive: true, force: true });
    }
    if (process.platform !== "win32") await chmod(join(staging, "bin", "mise"), 0o755);
  }

  async function runExternal(cmd: string, args: string[]): Promise<void> {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      execFile(cmd, args, { windowsHide: true, timeout: 120_000 }, (error) => {
        if (error) rejectPromise(error);
        else resolvePromise();
      });
    });
  }

  return {
    ensureBackend,
    async probeBackend() {
      try {
        await stat(backendExePath());
        return { available: true };
      } catch {
        return { available: false, reason: "便携 mise 后端尚未下载（按需获取）" };
      }
    },
    async installTool(params: { key: string; version: string }) {
      // 后端缺失时在此触发按需下载（probe 不落盘）。
      await ensureBackend();
      // 同 key 跨进程互斥：tool-store 下按 key 加锁；锁内 install 幂等（缓存命中 0.1s 实测）。
      await withFileLock(join(toolStoreDir, `${params.key}-${params.version}.lock`), async () => {
        const { code, stderr } = await runMiseExit(
          ["install", `${params.key}@${params.version}`],
          600_000,
        );
        if (code !== 0) throw new Error(`mise install ${params.key}@${params.version} failed: ${stderr.slice(-2000)}`);
      });
      // P0 实测：MISE_NO_CONFIG 下 `mise which` 不可用（依赖配置上下文），
      // 按 mise install 布局直接拼确切路径；Windows 是 <key>.exe，unix 是 <key>。
      const toolPath =
        process.platform === "win32"
          ? join(toolStoreDir, "data", "installs", params.key, params.version, `${params.key}.exe`)
          : join(toolStoreDir, "data", "installs", params.key, params.version, params.key);
      try {
        await stat(toolPath);
      } catch {
        throw new Error(
          `mise reported success but ${toolPath} is missing; refusing to fall back to PATH`,
        );
      }
      return { toolPath };
    },
  };
}
