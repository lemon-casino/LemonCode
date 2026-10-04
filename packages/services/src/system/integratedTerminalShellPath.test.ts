import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { listIntegratedTerminalShellOptions } from "./integratedTerminalShells.js";
import { createSystemService } from "./systemService.js";

for (const platform of ["win32", "darwin", "linux"] as const) {
  const windows = platform === "win32";
  const root = windows ? "D:\\自定义 Shell" : "/opt/自定义 Shell";
  const shell = windows ? `${root}\\bin\\bash.exe` : `${root}/bin/fish`;
  test(`${platform}: resolves an installation directory to executable files`, async () => {
    const result = await listIntegratedTerminalShellOptions({
      env: {},
      platform,
      path: root,
      pathKind: async () => "directory",
      isExecutable: async (path) => path === shell,
    });
    assert.deepEqual(
      result.map(({ path, dialect }) => [path, dialect]),
      [[shell, windows ? "git-bash" : "fish"]],
    );
  });

  test(`${platform}: accepts an explicitly selected custom executable`, async () => {
    const path = windows ? `${root}\\my-shell.exe` : `${root}/my-shell`;
    const result = await listIntegratedTerminalShellOptions({
      env: {},
      platform,
      path,
      pathKind: async () => "file",
      isExecutable: async () => true,
    });
    assert.equal(result.length, 1);
    assert.ok(result[0]);
    assert.equal(result[0].path, path);
    assert.equal(result[0].dialect, "custom");
    assert.equal(result[0].label, windows ? "my-shell.exe" : "my-shell");
  });
}

test("directory discovery keeps all candidates and never includes unrelated executables", async () => {
  const installed = new Set([
    "/opt/shells/bin/zsh",
    "/opt/shells/bin/bash",
    "/opt/shells/bin/node",
  ]);
  const result = await listIntegratedTerminalShellOptions({
    env: {},
    platform: "linux",
    path: "/opt/shells",
    pathKind: async () => "directory",
    isExecutable: async (path) => installed.has(path),
  });
  assert.deepEqual(result.map(({ path }) => path).sort(), [
    "/opt/shells/bin/bash",
    "/opt/shells/bin/zsh",
  ]);
});

test("Windows rejects text and batch files even when access(X_OK) succeeds", async () => {
  for (const path of ["C:\\shell.txt", "C:\\shell.cmd", "C:\\shell.bat"]) {
    assert.deepEqual(
      await listIntegratedTerminalShellOptions({
        env: {},
        platform: "win32",
        path,
        pathKind: async () => "file",
        isExecutable: async () => true,
      }),
      [],
    );
  }
});

test("rejects missing, relative and non-executable paths", async () => {
  for (const path of ["./bash", "/missing/bash", "/opt/bash --login"]) {
    assert.deepEqual(
      await listIntegratedTerminalShellOptions({
        env: {},
        platform: "linux",
        path,
        pathKind: async () => undefined,
        isExecutable: async () => false,
      }),
      [],
    );
  }
});

test("Windows requires a drive-qualified or UNC absolute path", async () => {
  for (const path of ["shell.exe", "C:shell.exe", "\\shell.exe", "/shell.exe"]) {
    assert.deepEqual(
      await listIntegratedTerminalShellOptions({
        env: {},
        platform: "win32",
        path,
        pathKind: async () => "file",
        isExecutable: async () => true,
      }),
      [],
    );
  }
  const path = "\\\\shell-host\\tools\\pwsh.exe";
  const result = await listIntegratedTerminalShellOptions({
    env: {},
    platform: "win32",
    path,
    pathKind: async () => "file",
    isExecutable: async () => true,
  });
  assert.equal(result[0]?.path, path);
});

test("real filesystem rejects directories as executables and checks POSIX permissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "lcode-shell-path-"));
  try {
    await mkdir(join(root, "bin"));
    const shell = join(root, "bin", process.platform === "win32" ? "pwsh.exe" : "fish");
    await writeFile(shell, "shell fixture");
    const options = { env: {}, platform: process.platform, path: root };
    if (process.platform !== "win32") {
      await chmod(shell, 0o644);
      assert.deepEqual(await listIntegratedTerminalShellOptions(options), []);
      await chmod(shell, 0o755);
    }
    assert.equal((await listIntegratedTerminalShellOptions(options))[0]?.path, shell);
    const service = createSystemService();
    assert.equal((await service.listIntegratedTerminalShells(root))[0]?.path, shell);
    assert.equal((await service.listIntegratedTerminalShells(shell))[0]?.path, shell);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
