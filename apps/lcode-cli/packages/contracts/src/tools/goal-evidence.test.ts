import assert from "node:assert/strict";
import test from "node:test";
import { goalAcceptanceSchema, goalRequirementMatches } from "./goal-evidence.js";
import { parseGoalCompletionVerificationText } from "./target.js";

test("strict parsing distinguishes valid negative decisions from infrastructure/shape failures and keeps legacy fail-open", () => {
  for (const output of [
    "invalid JSON",
    '{"passed":"true","reason":"guess"}',
    '{"passed":true}',
    '{"passed":true,"reason":"","nextAction":4}',
  ]) {
    const strict = parseGoalCompletionVerificationText(output, "strict");
    assert.equal(strict.passed, false);
    assert.equal(strict.nextAction, undefined);
  }
  assert.equal(parseGoalCompletionVerificationText("invalid JSON").passed, true);
  assert.deepEqual(
    parseGoalCompletionVerificationText(
      '```json\n{"passed":false,"reason":"missing test","nextAction":"run it"}\n```',
      "strict",
    ),
    { passed: false, reason: "missing test", nextAction: "run it" },
  );
});
test("acceptance rejects duplicate ids and unsafe coverage while world.run argv binds exactly", () => {
  const requirement = {
    id: "gate",
    description: "check",
    source: "world.run",
    command: "node",
    args: ["test.mjs"],
    inputPaths: ["source.ts"],
  };
  const accepted = goalAcceptanceSchema.parse({ policy: "strict", requirements: [requirement] });
  assert.equal(
    goalRequirementMatches(accepted.requirements[0]!, {
      source: "world.run",
      command: "node",
      args: ["test.mjs"],
    }),
    true,
  );
  assert.equal(
    goalRequirementMatches(accepted.requirements[0]!, {
      source: "world.run",
      command: "node",
      args: ["other.mjs"],
    }),
    false,
  );
  assert.equal(
    goalAcceptanceSchema.safeParse({ policy: "strict", requirements: [requirement, requirement] })
      .success,
    false,
  );
  for (const path of ["../secret", "C:\\secret", "/etc/passwd", ".git/config"]) {
    assert.equal(
      goalAcceptanceSchema.safeParse({
        policy: "strict",
        requirements: [{ ...requirement, inputPaths: [path] }],
      }).success,
      false,
    );
  }
});
