import assert from "node:assert/strict";
import test from "node:test";
import { enqueueCancellableRuntimeCommand } from "./runtime-command-submit.js";

test("runtime command submission rejects direct execution after shutdown begins", async () => {
  let cancelled = 0;
  let commandCreated = false;
  let commandEnqueued = false;
  const runtime = {
    enqueueRuntimeCommand: () => {
      commandEnqueued = true;
    },
    runtimeCommandQueue: {},
    shuttingDown: true,
  };

  await assert.rejects(
    enqueueCancellableRuntimeCommand(runtime as never, {
      createCommand: () => {
        commandCreated = true;
        return {} as never;
      },
      onCommandCancelled: () => {
        cancelled += 1;
      },
    }),
    /cancel/i,
  );

  assert.equal(cancelled, 1);
  assert.equal(commandCreated, false);
  assert.equal(commandEnqueued, false);
});
