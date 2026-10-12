import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { normalize, win32 } from "node:path";

const windowsShellCommandPattern = /\.(cmd|bat)$/i;
const windowsShellCommandNames = new Set(["npm", "pnpm"]);

export function resolveSpawnRuntimeOptions(command, platform = process.platform) {
  if (
    platform === "win32" &&
    (windowsShellCommandPattern.test(command) || windowsShellCommandNames.has(command))
  ) {
    return {
      // Windows runner 上 bare `pnpm` / `npm` 实际也是通过 cmd shim 提供。
      // 之前先把命令名改写成 `pnpm.cmd`，会让部分 `pnpm exec` 场景重新落回错误的包 cwd，
      // 最终把 tsup 入口解析成 scripts/src/... 并报“Cannot find src/main/index.ts”。
      // 这里保留原始命令名，只要求 shell/cmd.exe 负责解析 shim，避免再次改变 pnpm 的包上下文。
      shell: true,
    };
  }

  return {};
}

const cmdMetaCharacters = /([()\][%!^"`<>&|;, *?])/g;

function escapeCmdArgument(value) {
  const quoted = `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1")}"`;
  // CMD 启动和 batch 的 %* 各解析一次；只补引号会让内嵌引号后的 => 变成重定向。
  return quoted.replace(cmdMetaCharacters, "^$1").replace(cmdMetaCharacters, "^$1");
}

function prepareCommand(command, args, options) {
  if (/[\r\n]/.test(command)) {
    throw new Error("Command cannot contain newlines; use a script file or stdin.");
  }

  if (!resolveSpawnRuntimeOptions(command).shell) {
    return { command, args, options: { ...options, shell: false } };
  }

  const env = options.env ?? process.env;
  if (windowsShellCommandNames.has(command)) {
    const native = nativeCommandCandidates(command, env).find(existsSync);
    // 修复：托管 pnpm.exe 只有一轮 argv 解析；batch 的双 CMD 转义会把参数变成 ^--filter^。
    if (native) return { command: native, args, options: { ...options, shell: false } };
  }

  if (args.some((value) => /[\r\n]/.test(value))) {
    throw new Error("Windows batch arguments cannot contain newlines; use a script file or stdin.");
  }

  const comSpecKey = Object.keys(env).find((key) => key.toLowerCase() === "comspec");
  const commandLine = [
    normalize(command).replace(cmdMetaCharacters, "^$1"),
    ...args.map(escapeCmdArgument),
  ].join(" ");
  return {
    command: (comSpecKey && env[comSpecKey]) || "cmd.exe",
    args: ["/d", "/v:off", "/s", "/c", `"${commandLine}"`],
    options: { ...options, shell: false, windowsVerbatimArguments: true },
  };
}

function nativeCommandCandidates(command, env) {
  return (Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? "")
    .split(";")
    .filter(Boolean)
    .map((directory) => win32.join(directory.replace(/^"|"$/g, ""), `${command}.exe`));
}

export function spawnCommand(command, args, options = {}) {
  const prepared = prepareCommand(command, args, options);
  return spawn(prepared.command, prepared.args, prepared.options);
}

export async function execCommand(command, args, { maxBuffer = 1024 * 1024, ...options } = {}) {
  // 修复：execFile 的 shell:true 在 Node 24 直接拼接参数并触发 DEP0190；复用安全 batch 启动器。
  const child = spawnCommand(command, args, { ...options, stdio: "pipe" });
  const chunks = { stdout: [], stderr: [] };
  let length = 0;
  let overflow;
  for (const stream of ["stdout", "stderr"]) {
    child[stream].on("data", (chunk) => {
      length += chunk.length;
      if (length > maxBuffer) {
        overflow ??= Object.assign(new Error("Command output exceeded maxBuffer"), {
          code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
        });
        child.kill();
      } else chunks[stream].push(chunk);
    });
  }
  child.stdin.end();
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      const output = Object.fromEntries(
        Object.entries(chunks).map(([stream, buffers]) => [
          stream,
          Buffer.concat(buffers).toString("utf8"),
        ]),
      );
      if (overflow) reject(Object.assign(overflow, output));
      else if (code !== 0)
        reject(
          Object.assign(new Error(`Command failed (${code ?? signal})`), {
            code,
            signal,
            ...output,
          }),
        );
      else resolve(output);
    });
  });
}

/**
 * 解析要启动的真实可执行文件，避免再次进入会重解析参数的 CMD shim：
 * `node` 直接用启动器 runtime；Windows 上的 `pnpm`/`npm` 取磁盘上真实 `.cjs` 入口，
 * 并返回给启动器 runtime 作为脚本参数执行（CreateProcess 不能直接运行 .cjs）。
 * 解析不到时保持原命令名，沿用 resolveSpawnRuntimeOptions 的既有兼容路径。
 */
export function resolveRunCommand(requestedCommand, options = {}) {
  const nodeExecutablePath = options.nodeExecutablePath ?? process.execPath;
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const platform = options.platform ?? process.platform;

  if (/^(?:node|node\.exe)$/i.test(requestedCommand)) {
    return { command: nodeExecutablePath, args: [] };
  }
  if (platform !== "win32" || !/^(?:pnpm|npm)$/i.test(requestedCommand)) {
    return { command: requestedCommand, args: [] };
  }

  const candidates = [
    env.npm_execpath,
    // 旧 Host 尚未传 npm_execpath 时，托管启动器仍优先解析冻结 PATH 中的 native pnpm。
    ...(options.preferNativePath ? nativeCommandCandidates(requestedCommand, env) : []),
    (() => {
      const probe = spawnSync("volta", ["which", requestedCommand], {
        encoding: "utf8",
        windowsHide: true,
      });
      return probe.status === 0 ? probe.stdout.trim() : undefined;
    })(),
  ];
  for (const resolved of candidates) {
    if (!resolved) continue;
    const realEntry = /\.(cmd|bat)$/i.test(resolved)
      ? resolved.replace(/\.(cmd|bat)$/i, ".cjs")
      : resolved;
    if (exists(realEntry)) {
      // 修复：冻结 pnpm 也可能是原生 exe；作为 Node 脚本启动会在准备阶段立即失败。
      return /\.exe$/i.test(realEntry)
        ? { command: realEntry, args: [] }
        : { command: nodeExecutablePath, args: [realEntry] };
    }
  }
  return { command: requestedCommand, args: [] };
}

export function runCommand(command, args, options = {}) {
  const prepared = prepareCommand(command, args, { stdio: "inherit", ...options });
  const result = spawnSync(prepared.command, prepared.args, prepared.options);

  if (result.error) {
    throw result.error;
  }

  if (typeof result.status === "number" && result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with code ${result.status}`);
  }

  return result;
}

export function runCommandAndReadStdout(command, args, options = {}) {
  const prepared = prepareCommand(command, args, { encoding: "utf8", ...options });
  const result = spawnSync(prepared.command, prepared.args, prepared.options);

  if (result.error) {
    throw result.error;
  }

  if (typeof result.status === "number" && result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with code ${result.status}`);
  }

  return result.stdout;
}
