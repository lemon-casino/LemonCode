import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import type { ExecutionRequest } from "@lcode/contracts";
import { NodeExecutionAdapter } from "./node-execution-adapter.js";

for (const dialect of ["sh", "fish", "nushell"] as const) {
  const name = dialect === "nushell" ? "nu" : dialect;
  const paths = (process.env.PATH ?? "")
    .split(delimiter)
    .map((dir) => join(dir, `${name}${process.platform === "win32" ? ".exe" : ""}`));
  let path: string | undefined;
  for (const candidate of paths) {
    try {
      await access(candidate);
      path = candidate;
      break;
    } catch {
      /* optional installed Shell */
    }
  }
  test(
    `native ${dialect} preserves output, failure and cwd`,
    { skip: !path, timeout: 20_000 },
    async () => {
      const root = await mkdtemp(join(tmpdir(), "lcode-selected-shell-"));
      const target = join(root, "目录 with ' quotes");
      await mkdir(target);
      const adapter = new NodeExecutionAdapter({ outputRootDir: join(root, "output") });
      const request = (command: string, custom = false): ExecutionRequest => ({
        cwd: root,
        captureCwdAfterSuccess: true,
        timeoutMs: 8_000,
        command: {
          mode: "shell",
          shellProfile: "posix-bash",
          shellOverride: {
            dialect: custom ? "custom" : dialect,
            path,
            source: "user-config",
            display: { name },
          },
          command,
        },
      });
      const normalized = target.replaceAll("\\", "/");
      const quote =
        dialect === "nushell"
          ? JSON.stringify(target)
          : dialect === "fish"
            ? `'${normalized.replaceAll("'", "\\'")}'`
            : `'${normalized.replaceAll("'", "'\\''")}'`;
      try {
        const output = dialect === "nushell" ? "'中文 output'" : "printf '中文 output'";
        const moved = await adapter.run(request(`cd ${quote}\n${output}`));
        assert.equal(moved.exitCode, 0, moved.stdout.text + moved.stderr.text);
        assert.match(moved.stdout.text, /中文 output/);
        assert.equal(moved.resolvedCwd, await realpath(target));
        const failed = await adapter.run(request("exit 17"));
        assert.equal(failed.exitCode, 17);
        assert.equal(failed.resolvedCwd, undefined);
        const custom = await adapter.run(request(output, true));
        assert.equal(custom.exitCode, 0, custom.stdout.text + custom.stderr.text);
        assert.match(custom.stdout.text, /中文 output/);
        assert.equal(custom.resolvedCwd, undefined);
        if (dialect === "nushell") {
          const nativeFailure = await adapter.run(
            request(`^${JSON.stringify(process.execPath)} -e 'process.exit(7)'`),
          );
          assert.notEqual(nativeFailure.exitCode, 0, nativeFailure.stdout.text);
          assert.equal(nativeFailure.resolvedCwd, undefined);
          const invalid = await adapter.run(request("error make {msg: 'fixture failure'}"));
          assert.notEqual(invalid.exitCode, 0);
          assert.equal(invalid.resolvedCwd, undefined);
        }
      } finally {
        await adapter.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
}
