import { spawn } from "node:child_process";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { terminateProcessTreeAndWait } from "@lcode/services/process/processTreeTerminator";
import type { DependencyInstallPort } from "../app/ports.js";

export interface DependencyInstallOptions {
  resolveEnv?: () => Promise<NodeJS.ProcessEnv>;
  timeoutMs?: number;
}
function within(root: string, child: string): boolean {
  const value = relative(root, child);
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}
export async function managerCommand(
  manager: "npm" | "pnpm",
  paths: Readonly<Record<string, string>>,
): Promise<{ executable: string; prefix: string[]; toolPath: string }> {
  const node = paths.node;
  if (!node || !isAbsolute(node) || !(await lstat(node)).isFile())
    throw new Error("tool-unavailable: frozen Node is missing");
  const nodePath = await realpath(node);
  if (manager === "pnpm") {
    const pnpm = paths.pnpm;
    if (!pnpm || !isAbsolute(pnpm) || !(await lstat(pnpm)).isFile())
      throw new Error("tool-unavailable: frozen pnpm is missing");
    const path = await realpath(pnpm);
    if ([".cmd", ".bat"].includes(extname(path).toLowerCase()))
      throw new Error(
        "tool-unavailable: pnpm must resolve to its native or JavaScript entry, not a shell shim",
      );
    const script = [".cjs", ".mjs", ".js"].includes(extname(path).toLowerCase());
    return { executable: script ? nodePath : path, prefix: script ? [path] : [], toolPath: path };
  }
  const root = process.platform === "win32" ? dirname(nodePath) : resolve(dirname(nodePath), "..");
  const candidate =
    process.platform === "win32"
      ? join(root, "node_modules", "npm", "bin", "npm-cli.js")
      : join(root, "lib", "node_modules", "npm", "bin", "npm-cli.js");
  const npm = await realpath(candidate);
  if (!within(root, npm) || !(await lstat(npm)).isFile())
    throw new Error("tool-unavailable: bundled npm escaped the frozen Node installation");
  return { executable: nodePath, prefix: [npm], toolPath: npm };
}
export function createDependencyInstaller(options: DependencyInstallOptions = {}) {
  async function run(params: {
    executable: string;
    args: string[];
    cwd: string;
    toolPaths: Readonly<Record<string, string>>;
    env?: Record<string, string>;
    signal?: AbortSignal;
    onOutput?: (output: string) => Promise<void>;
  }) {
    params.signal?.throwIfAborted();
    const env = { ...((await options.resolveEnv?.()) ?? process.env) };
    const inheritedPath =
      Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? "";
    for (const key of Object.keys(env))
      if (key.toUpperCase() === "PATH" || key.toUpperCase().startsWith("MISE_")) delete env[key];
    const key = process.platform === "win32" ? "Path" : "PATH";
    const delimiter = process.platform === "win32" ? ";" : ":";
    Object.assign(env, params.env);
    const overlayPath = Object.entries(params.env ?? {}).find(
      ([name]) => name.toUpperCase() === "PATH",
    )?.[1];
    for (const name of Object.keys(env))
      if (name !== key && name.toUpperCase() === "PATH") delete env[name];
    env[key] = [dirname(params.toolPaths.node!), overlayPath ?? inheritedPath]
      .filter(Boolean)
      .join(delimiter);
    for (const name of [
      "TEMP",
      "TMP",
      "TMPDIR",
      "npm_config_cache",
      "npm_config_store_dir",
      "npm_config_prefix",
    ]) {
      if (env[name] && isAbsolute(env[name])) await mkdir(env[name], { recursive: true });
    }
    return new Promise<{ exitCode: number; output: string }>((resolveRun, rejectRun) => {
      const startedAt = Date.now();
      const child = spawn(params.executable, params.args, {
        cwd: params.cwd,
        env,
        shell: false,
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      let timedOut = false;
      let exitedAt: number | undefined;
      let spawnError: Error | undefined;
      let progress = Promise.resolve();
      let pending = "";
      let flushing = false;
      const append = (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        output = (output + text).slice(-64 * 1024);
        if (!params.onOutput) return;
        pending = (pending + text).slice(-64 * 1024);
        if (flushing) return;
        flushing = true;
        progress = (async () => {
          while (pending) {
            const value = pending;
            pending = "";
            await params.onOutput!(value);
          }
        })().finally(() => {
          flushing = false;
        });
        void progress.catch(() => {});
      };
      child.stdout.on("data", append);
      child.stderr.on("data", append);
      child.once("exit", () => {
        exitedAt = Date.now();
      });
      let stopping: ReturnType<typeof terminateProcessTreeAndWait> | undefined;
      const stop = () => {
        stopping ??= terminateProcessTreeAndWait(child, {
          ownedProcessGroupId: process.platform === "win32" ? undefined : child.pid,
          ownedProcessStartedAtMs: startedAt,
          resolveOwnedProcessExitedAtMs: () => exitedAt,
          forceAfterMs: 1000,
          waitAfterForceMs: 3000,
        });
        void stopping.catch(() => {});
      };
      const timeout = setTimeout(() => {
        timedOut = true;
        stop();
      }, options.timeoutMs ?? 600_000);
      const abort = () => stop();
      params.signal?.addEventListener("abort", abort, { once: true });
      if (params.signal?.aborted) stop();
      child.once("error", (error) => {
        spawnError = error;
      });
      child.once("close", async (code) => {
        clearTimeout(timeout);
        params.signal?.removeEventListener("abort", abort);
        try {
          if (spawnError) throw spawnError;
          if (stopping && (await stopping).remainingPids.length)
            throw Object.assign(
              new Error("process-unknown: dependency process tree has not confirmed exit"),
              { code: "process-unknown" },
            );
          await progress;
          resolveRun({
            exitCode: timedOut ? 124 : params.signal?.aborted ? 130 : (code ?? 1),
            output,
          });
        } catch (error) {
          rejectRun(error);
        }
      });
    });
  }
  const verifyManager: NonNullable<DependencyInstallPort["verifyManager"]> = async (params) => {
    const command = await managerCommand(params.manager, params.toolPaths);
    const result = await run({
      ...command,
      args: [...command.prefix, "--version"],
      cwd: dirname(params.toolPaths.node!),
      toolPaths: params.toolPaths,
      signal: params.signal,
    });
    const version = result.output.trim().split(/\r?\n/u).at(-1)?.trim();
    if (
      result.exitCode !== 0 ||
      !version ||
      !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/u.test(version) ||
      (params.expectedVersion && params.expectedVersion !== version)
    )
      throw new Error(
        `tool-unavailable: ${params.manager} version does not match the frozen declaration`,
      );
    return { version, toolPath: command.toolPath };
  };
  const installer: DependencyInstallPort & { runApprovedCommand: typeof run } = {
    runApprovedCommand: run,
    verifyManager,
    async install(params) {
      const manager = params.manager ?? (params.command === "npm ci" ? "npm" : "pnpm");
      if (manager !== "npm" && manager !== "pnpm")
        throw new Error("unsupported dependency manager");
      if (params.command !== (manager === "npm" ? "npm ci" : "pnpm install --frozen-lockfile"))
        throw new Error("unsupported managed dependency command");
      const toolPaths = params.toolPaths;
      if (!toolPaths) throw new Error("tool-unavailable: frozen dependency tool paths are missing");
      await verifyManager({
        manager,
        expectedVersion: params.managerVersion,
        toolPaths,
        signal: params.signal,
      });
      const command = await managerCommand(manager, toolPaths);
      const args =
        manager === "npm"
          ? ["ci"]
          : ["install", "--frozen-lockfile", "--package-import-method=clone-or-copy"];
      return run({
        ...command,
        args: [...command.prefix, ...args],
        cwd: params.cwd,
        toolPaths,
        env: params.env,
        signal: params.signal,
        onOutput: params.onOutput,
      });
    },
  };
  return installer;
}
