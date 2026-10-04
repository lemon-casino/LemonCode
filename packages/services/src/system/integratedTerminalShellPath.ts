import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { posix, win32 } from "node:path";
import type { IntegratedTerminalShellDialect, IntegratedTerminalShellOption } from "@lcode/shared";

export interface IntegratedTerminalShellProbeOptions {
  platform: NodeJS.Platform;
  isExecutable?: (path: string) => boolean | Promise<boolean>;
  pathKind?: (path: string) => Promise<"file" | "directory" | undefined>;
}

const SHELL_NAMES = [
  "pwsh",
  "powershell",
  "bash",
  "zsh",
  "fish",
  "sh",
  "nu",
  "cmd",
  "dash",
  "ksh",
  "tcsh",
  "csh",
] as const;

export async function isIntegratedTerminalShellExecutable(
  path: string,
  options: IntegratedTerminalShellProbeOptions,
): Promise<boolean> {
  // Windows 的 X_OK 与 F_OK 等价，目录/文本也会通过；node-pty 只能直接启动原生程序。
  // POSIX 必须同时验证文件类型和执行权限，避免把安装目录传给 spawn。
  if (options.platform === "win32" && !/\.(exe|com)$/i.test(path)) return false;
  if (options.isExecutable) return options.isExecutable(path);
  try {
    await access(path, constants.X_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function shellDescriptor(
  path: string,
  platform: NodeJS.Platform,
): {
  label: string;
  dialect: IntegratedTerminalShellDialect;
} {
  const name = (platform === "win32" ? win32 : posix).basename(path);
  const kind = name.replace(/\.(exe|com)$/i, "").toLowerCase();
  if (kind === "pwsh" || kind === "powershell")
    return {
      label: kind === "pwsh" ? "PowerShell 7" : "Windows PowerShell",
      dialect: "powershell",
    };
  if (kind === "cmd") return { label: "CMD", dialect: "cmd" };
  if (kind === "nu") return { label: "Nushell", dialect: "nushell" };
  if (kind === "fish" || kind === "sh") return { label: kind, dialect: kind };
  if (kind === "bash" && platform === "win32") return { label: "Git Bash", dialect: "git-bash" };
  if (kind === "bash" || kind === "zsh") return { label: kind, dialect: "posix" };
  return { label: name, dialect: "custom" };
}

export async function listSelectedIntegratedTerminalShellOptions(
  selectedPath: string,
  options: IntegratedTerminalShellProbeOptions,
): Promise<IntegratedTerminalShellOption[]> {
  const pathApi = options.platform === "win32" ? win32 : posix;
  const path = selectedPath.trim();
  // 不使用 resolve() 将相对路径补到 Host cwd，避免用户无意中配置了另一个工作区的文件。
  if (!pathApi.isAbsolute(path) || path.includes("\0")) return [];
  // Windows 的单个根斜杠仍依赖当前盘符，不是用户指定的完整绝对路径。
  if (
    options.platform === "win32" &&
    !/^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$))/i.test(path)
  )
    return [];
  let kind: "file" | "directory" | undefined;
  if (options.pathKind) {
    kind = await options.pathKind(path);
  } else {
    try {
      const info = await stat(path);
      kind = info.isFile() ? "file" : info.isDirectory() ? "directory" : undefined;
    } catch {
      return [];
    }
  }
  if (!kind) return [];
  const candidates =
    kind === "file"
      ? [path]
      : ["", "bin", "usr/bin", "7"].flatMap((dir) =>
          SHELL_NAMES.map((name) =>
            pathApi.join(path, dir, options.platform === "win32" ? `${name}.exe` : name),
          ),
        );
  const result: IntegratedTerminalShellOption[] = [];
  for (const candidate of candidates) {
    if (!(await isIntegratedTerminalShellExecutable(candidate, options))) continue;
    const descriptor = shellDescriptor(candidate, options.platform);
    result.push({
      ...descriptor,
      id: `${descriptor.dialect}:${candidate}`,
      path: candidate,
      source: "path",
    });
  }
  return result;
}
