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
    // 非 nul 设备名用法不受影响
    ["cmd > null", "cmd > null"],
    ["cmd > nul.txt", "cmd > nul.txt"],
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
