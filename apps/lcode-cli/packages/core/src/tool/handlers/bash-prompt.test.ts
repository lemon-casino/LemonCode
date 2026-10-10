import assert from "node:assert/strict";
import test from "node:test";
import { createBashProviderDescription } from "./bash-prompt.js";

for (const embeddedSearchEnabled of [false, true]) {
  test(`Bash guidance avoids Windows inline-code reparsing (embedded search: ${embeddedSearchEnabled})`, () => {
    const description = createBashProviderDescription({
      defaultTimeoutMs: 120_000,
      maxTimeoutMs: 600_000,
      embeddedSearchEnabled,
    });

    assert.match(description, /Windows.*(?:shim|wrapper).*CMD/);
    assert.match(description, /node -e.*tsx -e/);
    assert.match(description, /Git Bash.*quoted heredoc.*stdin/);
    assert.match(description, /CMD.*script file/);
    assert.match(description, /keep_alive_after_task/);
    assert.match(description, /Commit or push only when the user asks/);
    assert.match(description, /active Shell/);
    assert.match(description, /PowerShell.*\$env:NAME/);
  });
}
