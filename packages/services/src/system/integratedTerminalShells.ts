import { access, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { basename, posix, win32 } from "node:path";
import type { IntegratedTerminalShellDialect, IntegratedTerminalShellOption } from "@zcode/shared";

type ExecutableCheck = (path: string) => boolean | Promise<boolean>;

const WINDOWS_GIT_BASH_PATHS = [
  "C:\\Program Files\\Git\\bin\\bash.exe",
  "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
] as const;
const POSIX_SHELLS = ["zsh", "bash", "fish", "sh", "nu"] as const;
const POSIX_SHELL_DIRS = ["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"] as const;

export async function listIntegratedTerminalShellOptions(options: {
  env: NodeJS.ProcessEnv;
  isExecutable?: ExecutableCheck;
  platform: NodeJS.Platform;
}): Promise<IntegratedTerminalShellOption[]> {
  const result: IntegratedTerminalShellOption[] = [];
  const seen = new Set<string>();
  const windows = options.platform === "win32";

  async function add(
    candidate: string | undefined,
    label: string,
    dialect: IntegratedTerminalShellDialect,
    source: IntegratedTerminalShellOption["source"],
  ): Promise<void> {
    if (!candidate) return;
    const path = candidate.trim();
    const key = windows ? win32.normalize(path).toLowerCase() : path;
    if (!path || seen.has(key) || !(await isExecutableCandidate(path, options.isExecutable)))
      return;
    seen.add(key);
    result.push({ dialect, id: `${dialect}:${path}`, label, path, source });
  }

  if (windows) {
    const env = options.env;
    const programFiles = getWindowsEnvValue(env, "ProgramFiles") ?? "C:\\Program Files";
    const systemRoot = getWindowsEnvValue(env, "SystemRoot") ?? "C:\\Windows";
    await add(
      win32.join(programFiles, "PowerShell", "7", "pwsh.exe"),
      "PowerShell 7",
      "powershell",
      "system",
    );
    for (const path of windowsPathCandidates("pwsh.exe", env)) {
      await add(path, "PowerShell 7", "powershell", "path");
    }
    await add(
      win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      "Windows PowerShell",
      "powershell",
      "system",
    );
    for (const path of windowsPathCandidates("powershell.exe", env)) {
      await add(path, "Windows PowerShell", "powershell", "path");
    }
    for (const path of WINDOWS_GIT_BASH_PATHS) {
      await add(path, "Git Bash", "git-bash", "system");
    }
    for (const gitExe of windowsPathCandidates("git.exe", env)) {
      if (!(await isExecutableCandidate(gitExe, options.isExecutable))) continue;
      for (const path of inferWindowsGitBashPathsFromGitExe(gitExe)) {
        await add(path, "Git Bash", "git-bash", "path");
      }
    }
    await add(getWindowsEnvValue(env, "ComSpec"), "CMD", "cmd", "system");
    await add(win32.join(systemRoot, "System32", "cmd.exe"), "CMD", "cmd", "system");
    for (const path of windowsPathCandidates("cmd.exe", env)) {
      await add(path, "CMD", "cmd", "path");
    }
    for (const path of windowsPathCandidates("nu.exe", env)) {
      await add(path, "Nushell", "nushell", "path");
    }
    return result;
  }

  const loginShell = options.env.SHELL?.trim();
  const loginKind = loginShell && POSIX_SHELLS.find((kind) => basename(loginShell) === kind);
  if (loginKind) {
    await add(loginShell, posixShellLabel(loginKind), posixDialect(loginKind), "system");
  }
  for (const kind of POSIX_SHELLS) {
    for (const dir of [...(options.env.PATH?.split(posix.delimiter) ?? []), ...POSIX_SHELL_DIRS]) {
      if (!dir) continue;
      await add(posix.join(dir, kind), posixShellLabel(kind), posixDialect(kind), "path");
    }
  }
  return result;
}

function posixDialect(kind: (typeof POSIX_SHELLS)[number]): IntegratedTerminalShellDialect {
  if (kind === "bash" || kind === "zsh") return "posix";
  if (kind === "nu") return "nushell";
  return kind;
}

function posixShellLabel(kind: (typeof POSIX_SHELLS)[number]): string {
  return kind === "nu" ? "Nushell" : kind;
}

function inferWindowsGitBashPathsFromGitExe(gitExe: string): string[] {
  const gitDir = win32.dirname(gitExe);
  return [
    win32.normalize(win32.join(gitDir, "..", "bin", "bash.exe")),
    win32.normalize(win32.join(gitDir, "..", "..", "bin", "bash.exe")),
  ];
}

function windowsPathCandidates(command: string, env: NodeJS.ProcessEnv): string[] {
  return (getWindowsEnvValue(env, "PATH")?.split(win32.delimiter) ?? [])
    .filter(Boolean)
    .map((dir) => win32.join(dir, command));
}

function getWindowsEnvValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const match = Object.keys(env).find((envKey) => envKey.toLowerCase() === key.toLowerCase());
  return match ? env[match] : undefined;
}

async function isExecutableCandidate(path: string, check?: ExecutableCheck): Promise<boolean> {
  if (check) return check(path);
  try {
    await access(path, fsConstants.X_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
