import assert from "node:assert/strict";
import { test } from "node:test";
import { listIntegratedTerminalShellOptions } from "./integratedTerminalShells.js";

test("Windows detects installed shells and omits absent candidates", async () => {
  const installed = new Set([
    "C:\\Windows\\System32\\cmd.exe",
    "C:\\Tools\\pwsh.exe",
    "C:\\Program Files\\Git\\bin\\bash.exe",
  ]);
  const shells = await listIntegratedTerminalShellOptions({
    env: {
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      PATH: "C:\\Tools;C:\\Windows\\System32",
      PATHEXT: ".EXE;.CMD",
    },
    platform: "win32",
    isExecutable: async (path) => installed.has(path),
  });

  assert.deepEqual(
    shells.map(({ dialect, path }) => [dialect, path]),
    [
      ["powershell", "C:\\Tools\\pwsh.exe"],
      ["git-bash", "C:\\Program Files\\Git\\bin\\bash.exe"],
      ["cmd", "C:\\Windows\\System32\\cmd.exe"],
    ],
  );
});

test("POSIX detects the login shell and deduplicates paths", async () => {
  const installed = new Set(["/opt/homebrew/bin/fish", "/bin/zsh", "/bin/bash"]);
  const shells = await listIntegratedTerminalShellOptions({
    env: { SHELL: "/opt/homebrew/bin/fish", PATH: "/bin:/opt/homebrew/bin" },
    platform: "darwin",
    isExecutable: async (path) => installed.has(path),
  });

  assert.deepEqual(
    shells.map(({ dialect, path }) => [dialect, path]),
    [
      ["fish", "/opt/homebrew/bin/fish"],
      ["posix", "/bin/zsh"],
      ["posix", "/bin/bash"],
    ],
  );
});
