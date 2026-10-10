import assert from "node:assert/strict";
import test from "node:test";
import { bashToolEntry } from "./bash.js";
import { resolveBashPermissionRulePolicy } from "./bash-command-permission-policy.js";

for (const dialect of ["powershell", "fish", "nushell", "custom"] as const) {
  const context = {
    bashShellSelection: { dialect, display: { name: dialect }, source: "user-config" as const },
  };
  test(`${dialect} does not inherit POSIX readonly or prefix authorization`, () => {
    assert.equal(
      bashToolEntry.resolvePermissionCapability?.({ command: "echo hello" }, context),
      undefined,
    );
    const command = "git status";
    const policy = resolveBashPermissionRulePolicy({ command }, context)!;
    assert.equal(
      policy.evaluateRules("allow", [{ toolName: "Bash", ruleContent: "git:*" }]),
      false,
    );
    assert.equal(policy.evaluateRules("allow", [{ toolName: "Bash", ruleContent: command }]), true);
    assert.equal(policy.evaluateRules("deny", [{ toolName: "Bash", ruleContent: "git:*" }]), true);
    assert.deepEqual(policy.suggestedPermissionUpdates, [
      { type: "addRules", behavior: "allow", rules: [{ toolName: "Bash", ruleContent: command }] },
    ]);
  });
}
