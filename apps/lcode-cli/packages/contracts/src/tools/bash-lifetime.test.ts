import assert from "node:assert/strict";
import test from "node:test";
import { BashInputSchema } from "./bash.js";

test("preview retention is explicit and only valid for background Bash", () => {
  assert.equal(BashInputSchema.parse({ command: "pnpm dev" }).keep_alive_after_task, undefined);
  assert.equal(
    BashInputSchema.parse({ command: "pnpm dev", run_in_background: true, keep_alive_after_task: true }).keep_alive_after_task,
    true,
  );
  assert.equal(
    BashInputSchema.safeParse({ command: "pnpm dev", keep_alive_after_task: true }).success,
    false,
  );
});
