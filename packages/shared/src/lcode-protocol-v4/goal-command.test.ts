import assert from "node:assert/strict";
import test from "node:test";
import { goalCommandPayloadSchema, strictGoalCommandPayloadSchema } from "./goal-command.js";

test("strict command requires bounded acceptance and has a separate command identity from compatible legacy goals", () => {
  assert.equal(strictGoalCommandPayloadSchema.safeParse({ text: "task" }).success, false);
  assert.deepEqual(goalCommandPayloadSchema.parse({ text: "task" }), { text: "task" });
  const payload = strictGoalCommandPayloadSchema.parse({
    text: "task",
    acceptance: {
      policy: "strict",
      requirements: [
        {
          id: "test",
          description: "test",
          source: "Bash",
          command: "pnpm test",
          inputPaths: ["src/main.ts"],
        },
      ],
    },
  });
  assert.equal(payload.acceptance.policy, "strict");
  assert.equal(
    strictGoalCommandPayloadSchema.safeParse({ ...payload, unknownOption: true }).success,
    false,
  );
});
