import assert from "node:assert/strict";
import test from "node:test";
import type { ExecutionShellDialect, ExecutionShellSelection } from "@lcode/contracts";
import { resolveEffectiveBashShellSelection } from "./bash-shell-provider.js";
import { resolveExecutionCommand, applyResolvedShellCommand } from "./execution-command.js";

for (const dialect of [
  "cmd",
  "git-bash",
  "posix",
  "powershell",
  "fish",
  "sh",
  "nushell",
  "custom",
] as const) {
  for (const platform of ["win32", "linux", "darwin"] as const) {
    test(`selected ${dialect} is preserved on ${platform}`, () => {
      const path = platform === "win32" ? "C:/Shell Apps/chosen.exe" : "/opt/shells/chosen";
      const selection: ExecutionShellSelection = {
        dialect,
        path,
        source: "user-config",
        display: { name: "chosen" },
      };
      const resolution = resolveEffectiveBashShellSelection({
        override: selection,
        env: {},
        platform,
        exists: () => true,
      });
      assert.equal(resolution.selection.path, path);
      assert.equal(resolution.selection.dialect, dialect);
      const spawn = resolveExecutionCommand(
        {
          mode: "shell",
          shellProfile: "posix-bash",
          shellOverride: selection,
          command: "fixture source",
        },
        { platform, exists: () => true },
      );
      assert.equal(dialect === "cmd" ? spawn.shell : spawn.file, path);
      if (["fish", "sh", "nushell", "custom"].includes(dialect)) {
        assert.deepEqual(spawn.args, ["-c", "fixture source"]);
        assert.deepEqual(applyResolvedShellCommand(spawn, "next source").args, [
          "-c",
          "next source",
        ]);
      }
    });
  }
}

test("a missing explicitly selected executable cannot silently fall back", () => {
  for (const dialect of [
    "cmd",
    "git-bash",
    "posix",
    "powershell",
    "fish",
    "sh",
    "nushell",
    "custom",
  ] as ExecutionShellDialect[]) {
    assert.throws(
      () =>
        resolveEffectiveBashShellSelection({
          env: {},
          platform: "win32",
          exists: (path) => !path.includes("missing"),
          override: {
            dialect,
            display: { name: "missing" },
            path: "C:/missing/shell.exe",
            source: "user-config",
          },
        }),
      /Selected Shell is not executable/,
    );
  }
});
