import assert from "node:assert/strict";
import test from "node:test";
import { BashInputSchema } from "./bash.js";

test("preview retention is explicit and only valid for background Bash", () => {
  assert.equal(BashInputSchema.parse({ command: "pnpm dev" }).keep_alive_after_task, undefined);
  assert.equal(
    BashInputSchema.parse({
      command: "pnpm dev",
      run_in_background: true,
      keep_alive_after_task: true,
    }).keep_alive_after_task,
    true,
  );
  assert.equal(
    BashInputSchema.safeParse({ command: "pnpm dev", keep_alive_after_task: true }).success,
    false,
  );
});

test("background task and temporary service have explicit, validated purposes", () => {
  assert.equal(
    BashInputSchema.parse({ command: "build", run_in_background: true }).background_kind,
    undefined,
  );
  assert.equal(
    BashInputSchema.parse({
      command: "preview",
      run_in_background: true,
      background_kind: "service",
    }).background_kind,
    "service",
  );
  assert.equal(
    BashInputSchema.safeParse({
      command: "build",
      run_in_background: true,
      background_kind: "task",
      keep_alive_after_task: true,
    }).success,
    false,
  );
  assert.equal(
    BashInputSchema.safeParse({ command: "build", background_kind: "daemon" }).success,
    false,
  );
});
