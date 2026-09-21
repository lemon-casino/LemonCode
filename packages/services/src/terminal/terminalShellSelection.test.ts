import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveConfiguredTerminalShell } from "./terminalShellSelection.js";

test("uses the saved executable for a new terminal", async () => {
  const shell = await resolveConfiguredTerminalShell(
    {
      mode: "shell",
      dialect: "powershell",
      id: "pwsh",
      label: "PowerShell 7",
      path: "C:\\Tools\\pwsh.exe",
    },
    "powershell.exe",
    async (path) => path === "C:\\Tools\\pwsh.exe",
  );
  assert.equal(shell, "C:\\Tools\\pwsh.exe");
});

test("falls back when a saved shell was removed", async () => {
  const shell = await resolveConfiguredTerminalShell(
    { mode: "shell", dialect: "fish", id: "fish", label: "fish", path: "/missing/fish" },
    "/bin/zsh",
    async () => false,
  );
  assert.equal(shell, "/bin/zsh");
});
