import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type { EnvInfo } from "@lcode/contracts";

const DEFAULT_GIT_COMMAND_TIMEOUT_MS = 3000;
const DEFAULT_COMMAND_MAX_BUFFER_BYTES = 1024 * 1024;
const GIT_COMMAND = "git";
const GIT_STATUS_NOT_REPO = "not_repo" as const;
const GIT_STATUS_CLEAN = "clean" as const;
const GIT_STATUS_DIRTY = "dirty" as const;
const MAX_RECENT_COMMITS = 5;
const DEFAULT_MAIN_BRANCH_CANDIDATES = ["main", "master"] as const;
const MAX_GIT_STATUS_CONTEXT_CHARS = 2000;

const execFile = promisify(execFileCallback);

interface GitCommandResult {
  code: number;
  stderr: string;
  stdout: string;
}

interface ExecFileFailure extends Error {
  code?: number | string | null;
}

export async function resolveGitSnapshot(workingDirectory: string): Promise<Partial<EnvInfo>> {
  const insideWorkTree = await readTrimmedGitOutput(
    ["rev-parse", "--is-inside-work-tree"],
    workingDirectory,
  );
  if (insideWorkTree !== "true") {
    return {
      isGitRepository: false,
      gitStatus: GIT_STATUS_NOT_REPO,
    };
  }

  const gitBranch = await resolveGitBranch(workingDirectory);
  const gitMainBranch = await resolveMainBranch(workingDirectory);
  const gitUser = await resolveGitUser(workingDirectory);
  const statusOutput = await readGitOutput(
    ["--no-optional-locks", "status", "--short"],
    workingDirectory,
  );
  const gitStatusLines = splitGitStatusForContext(statusOutput?.trim() ?? "");
  const recentCommitOutput = await readGitOutput(
    ["--no-optional-locks", "log", "--oneline", "-n", String(MAX_RECENT_COMMITS)],
    workingDirectory,
  );
  const recentCommits = splitNonEmptyLines(recentCommitOutput).slice(0, MAX_RECENT_COMMITS);

  return {
    isGitRepository: true,
    gitBranch,
    gitMainBranch,
    gitUser,
    gitStatus: gitStatusLines.length > 0 ? GIT_STATUS_DIRTY : GIT_STATUS_CLEAN,
    gitStatusLines,
    recentCommits,
  };
}

async function resolveGitBranch(workingDirectory: string): Promise<string | undefined> {
  const branch = await readTrimmedGitOutput(
    ["rev-parse", "--abbrev-ref", "HEAD"],
    workingDirectory,
  );
  return branch || "HEAD";
}

async function resolveMainBranch(workingDirectory: string): Promise<string | undefined> {
  const remoteHead = await readTrimmedGitOutput(
    ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    workingDirectory,
  );
  const originHeadBranch = remoteHead?.replace(/^origin\//, "");
  const candidates = originHeadBranch
    ? [originHeadBranch, ...DEFAULT_MAIN_BRANCH_CANDIDATES]
    : [...DEFAULT_MAIN_BRANCH_CANDIDATES];

  for (const candidate of candidates) {
    if (
      await gitCommandSucceeds(
        ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`],
        workingDirectory,
      )
    ) {
      return candidate;
    }
  }

  return "main";
}

async function resolveGitUser(workingDirectory: string): Promise<string | undefined> {
  return readTrimmedGitOutput(["config", "user.name"], workingDirectory);
}

async function gitCommandSucceeds(args: string[], workingDirectory: string): Promise<boolean> {
  const result = await execGitNoThrow(args, workingDirectory);
  return result.code === 0;
}

async function readTrimmedGitOutput(
  args: string[],
  workingDirectory: string,
): Promise<string | undefined> {
  const output = await readGitOutput(args, workingDirectory);
  const trimmed = output?.trim();
  return trimmed ? trimmed : undefined;
}

async function readGitOutput(
  args: string[],
  workingDirectory: string,
): Promise<string> {
  const result = await execGitNoThrow(args, workingDirectory);
  return result.stdout;
}

async function execGitNoThrow(
  args: string[],
  workingDirectory: string,
): Promise<GitCommandResult> {
  try {
    const result = await execFile(GIT_COMMAND, args, {
      cwd: workingDirectory,
      encoding: "utf8",
      maxBuffer: DEFAULT_COMMAND_MAX_BUFFER_BYTES,
      timeout: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
      windowsHide: true,
    });
    return {
      code: 0,
      stderr: outputToString(result.stderr),
      stdout: outputToString(result.stdout),
    };
  } catch (error) {
    const failure = error as ExecFileFailure;
    return {
      code: typeof failure.code === "number" ? failure.code : 1,
      // 命令失败时丢弃 stdout/stderr，避免把不可靠的错误输出写入 provider-visible git context。
      stderr: "",
      stdout: "",
    };
  }
}

function outputToString(output: Buffer | string | undefined): string {
  if (typeof output === "string") {
    return output;
  }
  return output?.toString("utf8") ?? "";
}

function splitGitStatusForContext(status: string): string[] {
  if (status.length === 0) {
    return [];
  }

  const boundedStatus =
    status.length > MAX_GIT_STATUS_CONTEXT_CHARS
      ? `${status.substring(0, MAX_GIT_STATUS_CONTEXT_CHARS)}
... (truncated because it exceeds 2k characters. If you need more information, run "git status" using ${gitStatusToolName()})`
      : status;

  // 与上游 CLI 保持一致：git status 只按 2k 字符截断，不按文件条目数截断，避免 provider-visible prompt 形状漂移。
  return boundedStatus.split(/\r?\n/u).filter((line) => line.length > 0);
}

function gitStatusToolName(): "Bash" | "PowerShell" {
  return process.platform === "win32" ? "PowerShell" : "Bash";
}

function splitNonEmptyLines(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}
