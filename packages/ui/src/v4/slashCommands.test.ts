import assert from "node:assert/strict";
import test from "node:test";
import { parseV4VisibleSlashCommand } from "./slashCommands.js";

test("CLI strict syntax is never silently admitted as a legacy UI goal", () => {
  for (const command of [
    "/goal strict acceptance.json fix",
    "/target STRICT acceptance.json fix",
    "/goal replace strict acceptance.json fix",
  ]) {
    for (const attachments of [[], [{}]]) {
      assert.deepEqual(parseV4VisibleSlashCommand(command, attachments), {
        kind: "unsupportedGoal",
        action: "strict",
        displayText: command,
      });
    }
  }
  assert.equal(
    parseV4VisibleSlashCommand("/goal stricter error handling")?.kind,
    "sendGoalCommand",
  );
  assert.equal(parseV4VisibleSlashCommand("/goal replace fix regression")?.kind, "sendGoalCommand");
});
