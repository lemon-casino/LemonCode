import { constants } from "node:fs";
import { access, chmod, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, release } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import type { IPty } from "node-pty";
import type { RuntimeTerminalEnvironmentLease, TerminalWindowsPtyInfo } from "./terminal.js";

const require = createRequire(import.meta.url);
export type TerminalPtyModule = Pick<typeof import("node-pty"), "spawn">;
type PtySpawnOptions = Parameters<TerminalPtyModule["spawn"]>[2];
let nodePtyModulePromise: Promise<TerminalPtyModule> | null = null;
let helperPreparation: Promise<void> | null = null;

export async function loadNodePtyModule(): Promise<TerminalPtyModule> {
  if (!nodePtyModulePromise) {
    // remote server 注册服务不能因为本机缺少 pty.node 而使整条连接失败，只在真实创建时加载。
    nodePtyModulePromise = import("node-pty").catch((error: unknown) => {
      nodePtyModulePromise = null;
      throw new Error(`node-pty is unavailable in this runtime: ${errorMessage(error)}`);
    });
  }
  return nodePtyModulePromise;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function resolveTerminalWindowsPtyInfo(): TerminalWindowsPtyInfo | undefined {
  if (process.platform !== "win32") return undefined;
  const buildNumber = Number.parseInt(release().split(".")[2] ?? "", 10);
  return { backend: "conpty", buildNumber: Number.isFinite(buildNumber) ? buildNumber : undefined };
}

async function isExecutable(command: string): Promise<boolean> {
  const candidates = /[\\/]/.test(command)
    ? [command]
    : (process.env.PATH?.split(delimiter) ?? []).filter(Boolean).map((dir) => join(dir, command));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return true;
    } catch {
      /* 下一个 Host Shell 候选。 */
    }
  }
  return false;
}

function resolveNodePtySpawnHelperPath(): string | null {
  if (process.platform !== "darwin") return null;
  try {
    const utils = require("node-pty/lib/utils") as {
      loadNativeModule(name: string): { dir: string };
    };
    const native = utils.loadNativeModule("pty");
    const unixTerminalPath = require.resolve("node-pty/lib/unixTerminal.js");
    return resolve(dirname(unixTerminalPath), `${native.dir}/spawn-helper`)
      .replace("app.asar", "app.asar.unpacked")
      .replace("node_modules.asar", "node_modules.asar.unpacked");
  } catch {
    return null;
  }
}

export async function ensureNodePtySpawnHelperExecutable(): Promise<void> {
  if (process.platform !== "darwin") return;
  helperPreparation ??= (async () => {
    const helperPath = resolveNodePtySpawnHelperPath();
    if (!helperPath) return;
    try {
      await stat(helperPath);
    } catch {
      return;
    }
    try {
      await access(helperPath, constants.X_OK);
      return;
    } catch {
      /* 校正安装产物权限。 */
    }
    // macOS node-pty 必须执行 spawn-helper；安装产物丢失执行位会让 PTY 报 posix_spawnp failed。
    try {
      await chmod(helperPath, 0o755);
      await access(helperPath, constants.X_OK);
    } catch (error) {
      throw new Error(
        `node-pty spawn-helper is not executable: ${helperPath}. ${errorMessage(error)}`,
      );
    }
  })().catch((error) => {
    helperPreparation = null;
    throw error;
  });
  await helperPreparation;
}

function isUtf8Locale(value: string | undefined): boolean {
  return /utf-?8/i.test(value ?? "");
}
function isMissingOrCLocale(value: string | undefined): boolean {
  const normalized = (value ?? "").trim().toUpperCase();
  return normalized === "" || normalized === "C" || normalized === "POSIX";
}

const DARWIN_GUI_FALLBACK_PATHS = [
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
  "/usr/local/sbin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
] as const;

function mergePathEntries(entries: readonly (string | undefined)[]): string {
  const seen = new Set<string>();
  for (const value of entries) {
    for (const entry of value?.split(delimiter) ?? []) {
      const trimmed = entry.trim();
      if (trimmed) seen.add(trimmed);
    }
  }
  return [...seen].join(delimiter);
}

export function resolveTerminalEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const nextEnv = { ...env };
  const fallbackLocale =
    [env.LC_ALL, env.LC_CTYPE, env.LANG].find(isUtf8Locale) ??
    (process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8");
  // Dock/Finder 继承的 PATH 可能过窄；只补 PTY 的常见目录，保留用户顺序，不改全局环境。
  if (process.platform === "darwin") {
    nextEnv.PATH = mergePathEntries([env.PATH, ...DARWIN_GUI_FALLBACK_PATHS]);
  }
  // runtime 非交互采集的 TERM=dumb / CI=1 不应该让真实终端降级。
  nextEnv.TERM = "xterm-256color";
  nextEnv.COLORTERM = nextEnv.COLORTERM?.trim() || "truecolor";
  if (nextEnv.CI === "1" && env.TERM === "dumb") delete nextEnv.CI;
  if (isMissingOrCLocale(nextEnv.LANG)) nextEnv.LANG = fallbackLocale;
  if (isMissingOrCLocale(nextEnv.LC_CTYPE)) nextEnv.LC_CTYPE = fallbackLocale;
  if (nextEnv.LC_ALL !== undefined && isMissingOrCLocale(nextEnv.LC_ALL)) {
    nextEnv.LC_ALL = fallbackLocale;
  }
  return nextEnv;
}

export function applyTerminalEnvironment(
  base: NodeJS.ProcessEnv,
  overlay: RuntimeTerminalEnvironmentLease["envOverlay"],
  platform = process.platform,
): NodeJS.ProcessEnv {
  const env = overlay.base === "empty" ? {} : { ...base };
  const remove = (key: string) => {
    for (const name of Object.keys(env)) {
      // Windows 的 Path/PATH 同名；保留双键会让 node-pty 选中宿主 PATH 而非冻结工具路径。
      if (platform === "win32" ? name.toUpperCase() === key.toUpperCase() : name === key)
        delete env[name];
    }
  };
  for (const key of overlay.unset ?? []) remove(key);
  for (const [key, value] of Object.entries(overlay.set ?? {})) {
    remove(key);
    env[key] = value;
  }
  return env;
}

export function spawnTerminalProcess(params: {
  nodePty: TerminalPtyModule;
  shell: string;
  cols: number;
  rows: number;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): IPty {
  const { nodePty, shell, cols, rows, cwd, env } = params;
  const base = {
    name: "xterm-256color",
    cols,
    rows,
    cwd,
    env,
    encoding: "utf8",
  } satisfies PtySpawnOptions;
  if (process.platform !== "win32") return nodePty.spawn(shell, [], base);
  try {
    return nodePty.spawn(shell, [], { ...base, useConpty: true, useConptyDll: true });
  } catch (error) {
    if (
      !/conpty\.node module handle|conpty\.node module file name|cannot find conpty\.dll|error code:\s*126/i.test(
        errorMessage(error),
      )
    ) {
      throw error;
    }
    // 仅 DLL 装载失败（尚未启动 Shell）可回退到系统 ConPTY，不把普通启动失败当作可重试。
    return nodePty.spawn(shell, [], { ...base, useConpty: true, useConptyDll: false });
  }
}

export async function resolveTerminalShell(): Promise<string> {
  // 保留既有用户 Shell 选择的默认候选与 Windows PowerShell 7 优先规则。
  const candidates =
    process.platform === "win32"
      ? ["pwsh.exe", "powershell.exe", process.env.ComSpec, "cmd.exe"]
      : [process.env.SHELL, "/bin/zsh", "/bin/bash", "/bin/sh"];
  for (const candidate of candidates) {
    if (candidate && (await isExecutable(candidate))) return candidate;
  }
  throw new Error("No usable shell found for terminal startup");
}

export async function resolveTerminalCwd(cwd?: string, managed = false): Promise<string> {
  // 托管 cwd 已通过 binding 授权，不存在时必须失败，不能静默落到 HOME 绕过环境边界。
  const candidates = managed ? [cwd] : [cwd, process.env.HOME, homedir(), "/"];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if ((await stat(candidate)).isDirectory()) return candidate;
    } catch {
      /* 下个 legacy 候选。 */
    }
  }
  throw new Error("No usable working directory found for terminal startup");
}
