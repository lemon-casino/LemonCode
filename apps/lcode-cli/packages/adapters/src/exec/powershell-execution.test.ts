import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import type { ExecutionRequest, ExecutionShellSelection } from "@lcode/contracts";
import { resolveEffectiveBashShellSelection } from "./bash-shell-provider.js";
import { resolveExecutionCommand, applyResolvedShellCommand } from "./execution-command.js";
import { buildEmbeddedSearchPreludeContent } from "./embedded-search-prelude.js";
import { NodeExecutionAdapter } from "./node-execution-adapter.js";

const selection = (path: string): ExecutionShellSelection => ({
  dialect: "powershell",
  path,
  display: { name: "PowerShell 7" },
  source: "user-config",
});
const psQuote = (value: string) => `'${value.replaceAll("'", "''")}'`;

for (const platform of ["win32", "linux", "darwin"] as const) {
  test(`explicit PowerShell wins over automatic Bash on ${platform}`, () => {
    const path = platform === "win32" ? "C:\\Shell Apps\\pwsh.exe" : "/opt/shells/pwsh";
    const result = resolveEffectiveBashShellSelection({
      env: { SHELL: "/bin/bash" },
      platform,
      override: selection(path),
      exists: () => true,
    });
    assert.equal(result.selection.dialect, "powershell");
    assert.equal(result.selection.path, path);
    assert.equal(result.provider?.file, path);
    assert.equal(result.provider?.shell, false);
  });
}

test("PowerShell passes source without POSIX rewriting or shell string reparsing", () => {
  const command = "Write-Output '中文 $x `ticks`'; Write-Output '2>nul'";
  const resolved = resolveExecutionCommand(
    {
      mode: "shell",
      shellProfile: "posix-bash",
      shellOverride: selection("C:/Shell/pwsh.exe"),
      command,
    },
    { platform: "win32", exists: () => true },
  );
  assert.equal(resolved.file, "C:/Shell/pwsh.exe");
  assert.equal(resolved.cwdDialect, "powershell");
  assert.equal(resolved.shell, false);
  assert.ok(resolved.args.includes("-EncodedCommand"));
  assert.ok(Buffer.from(resolved.args.at(-1)!, "base64").toString("utf16le").includes(command));
  const rewritten = applyResolvedShellCommand(resolved, "Write-Output 'new'");
  assert.equal(rewritten.file, resolved.file);
  assert.match(
    Buffer.from(rewritten.args.at(-1)!, "base64").toString("utf16le"),
    /Write-Output 'new'/,
  );
  assert.equal(
    buildEmbeddedSearchPreludeContent(
      {
        kind: "embedded-search",
        backend: {
          kind: "native-binaries",
          findCommand: "find",
          grepCommand: "grep",
          rgCommand: "rg",
        },
      },
      { shellDialect: "powershell" },
    ),
    undefined,
  );
});

const candidates = [
  ...(process.env.PATH ?? "")
    .split(delimiter)
    .map((dir) => join(dir, process.platform === "win32" ? "pwsh.exe" : "pwsh")),
  ...(process.platform === "win32"
    ? [
        join(
          process.env.SystemRoot ?? "C:/Windows",
          "System32/WindowsPowerShell/v1.0/powershell.exe",
        ),
      ]
    : []),
];
const available = (
  await Promise.all(
    candidates.map(async (path) => {
      try {
        await access(path);
        return path;
      } catch {
        return undefined;
      }
    }),
  )
).filter((path): path is string => path !== undefined);
const shells = [...new Set(available)];

for (const path of shells.length ? shells : [undefined]) {
  test(
    `native PowerShell executes, reports failures, captures cwd and cancels: ${path ?? "unavailable"}`,
    {
      skip: path === undefined,
      timeout: 30_000,
    },
    async () => {
      const root = await mkdtemp(join(tmpdir(), "lcode-powershell-"));
      const target = join(root, "目录 with ' quotes");
      await mkdir(target);
      const adapter = new NodeExecutionAdapter({ outputRootDir: join(root, "output") });
      const request = (command: string): ExecutionRequest => ({
        command: {
          mode: "shell",
          shellProfile: "posix-bash",
          shellOverride: selection(path!),
          command,
        },
        cwd: root,
        captureCwdAfterSuccess: true,
        timeoutMs: 10_000,
      });
      try {
        const probe = await adapter.run(
          request(
            "$PSVersionTable.PSVersion.ToString(); (Get-Process -Id $PID).Path; Write-Output '中文输出'",
          ),
        );
        assert.equal(probe.exitCode, 0, probe.error?.message ?? probe.stderr.text);
        assert.match(probe.stdout.text, /中文输出/);
        assert.ok(probe.stdout.text.toLowerCase().includes(path!.toLowerCase()));
        const moved = await adapter.run(
          request(`Set-Location -LiteralPath ${psQuote(target)}; Write-Output 'moved'`),
        );
        assert.equal(moved.exitCode, 0, moved.stderr.text);
        assert.equal(moved.resolvedCwd, await realpath(target));
        for (const [command, code] of [
          ["exit 19", 19],
          [`& ${psQuote(process.execPath)} -e 'process.exit(7)'`, 7],
          ["Write-Error 'intentional failure'", 1],
          ["throw 'intentional exception'", 1],
        ] as const) {
          const failed = await adapter.run(request(command));
          assert.equal(
            failed.exitCode,
            code,
            `${command}: ${failed.stdout.text} ${failed.stderr.text}`,
          );
          assert.equal(failed.resolvedCwd, undefined);
        }
        const recovered = await adapter.run(
          request(`& ${psQuote(process.execPath)} -e 'process.exit(7)'; Write-Output 'recovered'`),
        );
        assert.equal(
          recovered.exitCode,
          0,
          "a successful final cmdlet must not inherit stale LASTEXITCODE",
        );
        const started = Promise.withResolvers<void>();
        const task = await adapter.start(request("Start-Sleep -Seconds 30"), {
          onEvent: (event) => {
            if (event.type === "started") started.resolve();
          },
        });
        await started.promise;
        await adapter.cancelBackgroundTask(task.taskId);
        assert.equal((await adapter.waitForBackgroundTask(task.taskId))?.status, "cancelled");
      } finally {
        await adapter.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
}
