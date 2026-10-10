import { mkdirSync, readFileSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { powerShellCwdCaptureCommand } from "./powershell-command.js";
import { fishCwdCaptureCommand, nushellCwdCaptureCommand } from "./alternative-shell-cwd.js";
import {
  gitBashPathToWindowsPath,
  type ExecutionCommand,
  type ExecutionRequest,
  type ExecutionShellDialect,
  windowsPathToGitBashPath,
} from "@lcode/contracts";

interface CwdCapturePlan {
  command: ExecutionCommand;
  cwdFilePath?: string;
}

export function createCwdCapturePlan(
  request: ExecutionRequest,
  options: {
    dialect: ExecutionShellDialect;
    platform: NodeJS.Platform;
  },
): CwdCapturePlan {
  if (request.captureCwdAfterSuccess !== true || request.command.mode !== "shell") {
    return { command: request.command };
  }
  // 未知程序只保证原样执行 -c，不能猜测其状态变量或 cwd 语法而破坏用户命令。
  if (options.dialect === "custom") return { command: request.command };

  const cwdCaptureDir = tmpdir();
  mkdirSync(cwdCaptureDir, { recursive: true });
  const cwdFilePath = join(cwdCaptureDir, `lcode-${crypto.randomUUID()}-cwd`);

  // 每次 Bash 仍启动新 shell；成功后只把最终 pwd -P 写回主进程，不能持久化 env/alias/function。
  // 默认 shell、hooks、background command 不走这个分支，避免改变其它执行面。
  const wrappedCommand =
    options.dialect === "fish"
      ? fishCwdCaptureCommand(request.command.command, cwdFilePath)
      : options.dialect === "nushell"
        ? nushellCwdCaptureCommand(request.command.command, cwdFilePath)
        : options.dialect === "powershell"
          ? powerShellCwdCaptureCommand(request.command.command, cwdFilePath)
          : options.dialect === "cmd"
            ? createWindowsCmdCwdCaptureCommand(request.command.command, cwdFilePath)
            : createPosixCwdCaptureCommand(
                request.command.command,
                options.dialect === "git-bash"
                  ? windowsPathToGitBashPath(cwdFilePath)
                  : options.dialect === "sh" && options.platform === "win32"
                    ? cwdFilePath.replaceAll("\\", "/")
                    : cwdFilePath,
                options.platform === "win32" &&
                  (options.dialect === "sh" || options.dialect === "git-bash"),
              );

  return {
    command: {
      ...request.command,
      command: wrappedCommand,
    },
    cwdFilePath,
  };
}

function createPosixCwdCaptureCommand(
  command: string,
  cwdFilePath: string,
  windowsPath = false,
): string {
  // MSYS 的 /tmp 等挂载路径不能靠盘符替换还原；内置 pwd -W 返回真实 Windows 路径。
  const pwd = windowsPath ? "pwd -P -W" : "pwd -P";
  return [
    command,
    "__lcode_status=$?",
    `if [ "$__lcode_status" -eq 0 ]; then ${pwd} > ${shellQuote(cwdFilePath)}; fi`,
    'exit "$__lcode_status"',
  ].join("\n");
}

function createWindowsCmdCwdCaptureCommand(command: string, cwdFilePath: string): string {
  return [
    command,
    'set "__lcode_status=%ERRORLEVEL%"',
    `if "%__lcode_status%"=="0" cd > ${cmdQuote(cwdFilePath)}`,
    "exit /b %__lcode_status%",
  ].join("\r\n");
}

export function readCapturedCwd(
  cwdFilePath: string | undefined,
  options: { dialect: ExecutionShellDialect },
): string | undefined {
  if (!cwdFilePath) return undefined;
  try {
    const value = readFileSync(cwdFilePath, "utf8").replace(/\r?\n$/u, "");
    if (!value) return undefined;
    const hostValue = normalizeCapturedCwdForHost(value, options.dialect);
    const stats = statSync(hostValue);
    if (!stats.isDirectory()) return undefined;
    return realpathSync(hostValue);
  } catch {
    return undefined;
  } finally {
    try {
      unlinkSync(cwdFilePath);
    } catch {
      // cwd 捕获只影响内部会话状态，清理失败不能影响工具结果。
    }
  }
}

function normalizeCapturedCwdForHost(value: string, dialect: ExecutionShellDialect): string {
  return dialect === "git-bash" || (dialect === "sh" && process.platform === "win32")
    ? gitBashPathToWindowsPath(value)
    : value;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function cmdQuote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
