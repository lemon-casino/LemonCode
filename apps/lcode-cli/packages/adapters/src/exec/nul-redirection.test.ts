import assert from "node:assert/strict";
import test from "node:test";
import {
  applyResolvedShellCommand,
  resolveExecutionCommand,
  type ResolvedSpawnCommand,
} from "./execution-command.js";
import { normalizeCmdNulRedirectionForPosixShell } from "./nul-redirection.js";

test("nul 重定向归一化覆盖常见 CMD 写法并保留重定向语义", () => {
  const cases: Array<[string, string]> = [
    ["dir /s /b LICENSE* > nul 2>&1", "dir /s /b LICENSE* >/dev/null 2>&1"],
    ["reg query HKLM\\Software 2>nul", "reg query HKLM\\Software 2>/dev/null"],
    ["ping -n 1 localhost>NUL", "ping -n 1 localhost>/dev/null"],
    ["command >> nul", "command >>/dev/null"],
    ["build 1>nul 2>nul", "build 1>/dev/null 2>/dev/null"],
    ["where git 2>Nul", "where git 2>/dev/null"],
    ["start /b app >nul&echo done", "start /b app >/dev/null&echo done"],
    // Git Bash 实测：引号包裹的 nul 同样会落盘成文件（命令与重定向解析都成立），
    // 必须连引号一起替换；仅裸 nul 的旧模式会漏掉这些写法。
    ['reg query HKLM\\Software 2>"NUL"', "reg query HKLM\\Software 2>/dev/null"],
    ["dir > 'nul'", "dir >/dev/null"],
    ["build 1>\"nul\" 2>'NUL'", "build 1>/dev/null 2>/dev/null"],
    ["append >>\"NUL\"", "append >>/dev/null"],
    ["start /b app >\"nul\"&echo done", "start /b app >/dev/null&echo done"],
    // 非 nul 设备名用法不受影响
    ["cmd > null", "cmd > null"],
    ["cmd > nul.txt", "cmd > nul.txt"],
    ['cmd > "null"', 'cmd > "null"'],
    ['cmd > "nul".txt', 'cmd > "nul".txt'],
    ["cat <<nul", "cat <<nul"],
    ["wc -l <nul", "wc -l <nul"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(normalizeCmdNulRedirectionForPosixShell(input), expected, input);
  }
});

test("引号内的 nul 字面量同样被改写（记录已知局限）", () => {
  assert.equal(normalizeCmdNulRedirectionForPosixShell("echo '> nul'"), "echo '>/dev/null'");
});

test("git-bash dialect 下 spawn 命令归一化 nul 重定向", () => {
  const resolved = resolveExecutionCommand(
    {
      mode: "shell",
      command: "dir /s /b LICENSE* > nul 2>&1",
      shellProfile: "posix-bash",
    },
    {
      platform: "win32",
      env: {},
      exists: (path) => path.toLowerCase().includes("bash.exe"),
    },
  );
  assert.equal(resolved.cwdDialect, "git-bash");
  assert.equal(resolved.args.at(-1), "dir /s /b LICENSE* >/dev/null 2>&1");

  // 用户实测：带引号的 `2>"NUL"` 在 Git Bash 下同样落盘，必须经同一漏斗改写。
  const quoted = resolveExecutionCommand(
    {
      mode: "shell",
      command: 'reg query HKLM\\Software 2>"NUL"',
      shellProfile: "posix-bash",
    },
    {
      platform: "win32",
      env: {},
      exists: (path) => path.toLowerCase().includes("bash.exe"),
    },
  );
  assert.equal(quoted.cwdDialect, "git-bash");
  assert.equal(quoted.args.at(-1), "reg query HKLM\\Software 2>/dev/null");
});

test("cmd dialect 保持 nul 空设备语义不改写", () => {
  const resolved = resolveExecutionCommand(
    {
      mode: "shell",
      command: "dir > nul",
      shellProfile: "posix-bash",
      shellOverride: {
        dialect: "cmd",
        path: "cmd.exe",
        source: "user-config",
        display: { name: "CMD" },
      },
    },
    { platform: "win32", env: {}, exists: () => false },
  );
  assert.equal(resolved.cwdDialect, "cmd");
  assert.equal(resolved.file, "dir > nul");
});

test("持久 shell 会话按 cwdDialect 决定是否归一化", () => {
  const posixResolved: ResolvedSpawnCommand = {
    args: ["-c", "-l", ""],
    cwdDialect: "git-bash",
    file: "bash.exe",
    shell: false,
    usesLoginShell: true,
  };
  const applied = applyResolvedShellCommand(posixResolved, "reg query HKLM 2>nul");
  assert.deepEqual(applied.args, ["-c", "-l", "reg query HKLM 2>/dev/null"]);

  const cmdResolved: ResolvedSpawnCommand = {
    args: [],
    cwdDialect: "cmd",
    file: "cmd.exe",
    shell: "cmd.exe",
  };
  const untouched = applyResolvedShellCommand(cmdResolved, "dir > nul");
  assert.equal(untouched.file, "dir > nul");
});

test("posix 平台的裸 shell 命令同样归一化，win32 保持 cmd 语义", () => {
  const posix = resolveExecutionCommand(
    { mode: "shell", command: "make > nul", shell: true },
    { platform: "linux", env: {} },
  );
  assert.equal(posix.cwdDialect, "posix");
  assert.equal(posix.file, "make >/dev/null");

  const win32 = resolveExecutionCommand(
    { mode: "shell", command: "make > nul", shell: true },
    { platform: "win32", env: {} },
  );
  assert.equal(win32.cwdDialect, "cmd");
  assert.equal(win32.file, "make > nul");
});
