import assert from "node:assert/strict";
import test from "node:test";
import { integratedTerminalShellToExecutionSelection } from "./integrated-terminal-shell.js";

test("Host Shell settings preserve every supported and custom dialect", () => {
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
    const path = "/opt/custom-shell/chosen";
    const selected = integratedTerminalShellToExecutionSelection({
      mode: "shell",
      id: "fixture",
      label: "chosen",
      path,
      dialect,
    });
    assert.equal(selected?.path, path);
    assert.equal(selected?.dialect, dialect);
    assert.equal(selected?.source, "user-config");
  }
  assert.equal(integratedTerminalShellToExecutionSelection({ mode: "auto" }), undefined);
  assert.equal(integratedTerminalShellToExecutionSelection(undefined), undefined);
});
