import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseLCodeProcessDiagnostic } from "@lcode/shared/process-diagnostic";

for (const kind of ["uncaughtException", "unhandledRejection"])
  test(
    `real ${kind} closes live H2 resources and retains one diagnostic/close ID`,
    { timeout: 8000 },
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "lcode-fatal-"));
      const fixture = fileURLToPath(new URL("../scripts/http2-fatal.fixture.ts", import.meta.url));
      const child = spawn(
        process.execPath,
        ["--unhandled-rejections=strict", "--import", "tsx", fixture, directory, kind],
        { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
      );
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      const closed = once(child, "close");
      try {
        const [code] = await closed;
        assert.equal(code, 1, stderr.slice(-1000));
        const diagnostics = stderr
          .split("\n")
          .map(parseLCodeProcessDiagnostic)
          .filter((item) => item !== undefined);
        assert.equal(diagnostics.length, 1);
        const diagnostic = diagnostics[0]!;
        assert.equal(diagnostic.version, 2);
        assert.equal(diagnostic.kind, kind);
        if (diagnostic.version === 2) {
          assert.equal(diagnostic.code, "ERR_ASSERTION");
          assert.match(diagnostic.frames.join("\n"), /at owner/);
        }
        const result = JSON.parse(stdout.trim());
        assert.equal(result.errorId, diagnostic.errorId);
        assert.equal(result.closeErrorId, diagnostic.errorId);
        assert.equal(result.phase, "closed");
        assert.equal(result.activeRequests, 0);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await closed;
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
