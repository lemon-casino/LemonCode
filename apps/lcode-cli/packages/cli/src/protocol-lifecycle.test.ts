import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { createProtocolProcessLifecycle } from "./protocol-lifecycle.js";

test("signal attribution preserves its first absolute deadline", async (t) => {
  const original = process.on.bind(process);
  let terminate: (() => void) | undefined;
  t.mock.method(process, "on", (event: string | symbol, listener: (...args: unknown[]) => void) => {
    if (event === "SIGTERM") terminate = listener as () => void;
    return original(event, listener);
  });
  const output = new PassThrough();
  const lifecycle = createProtocolProcessLifecycle({
    input: new PassThrough(),
    output,
    stderr: output,
    exitProcess: () => {},
  });
  terminate!();
  const first = lifecycle.shutdownContext!;
  assert.equal(first.origin, "signal");
  assert.equal(first.signal, "SIGTERM");
  assert.equal(first.transportAvailable, true);
  lifecycle.requestShutdown(new Error("secondary"));
  assert.equal(lifecycle.deadlineAt, first.deadlineAt);
  await lifecycle.complete(0);
});

test("protocol lifecycle preserves first EOF attribution and releases listeners", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const exits: number[] = [];
  const listeners = process.listenerCount("SIGTERM");
  const lifecycle = createProtocolProcessLifecycle({
    input,
    output,
    stderr: output,
    exitProcess: (code) => exits.push(code),
  });
  input.emit("end");
  const first = lifecycle.shutdownContext;
  assert.equal(first?.origin, "stdin_eof");
  assert.equal(first?.transportAvailable, false);
  lifecycle.requestShutdown(new Error("secondary failure"));
  assert.equal(lifecycle.shutdownContext, first);
  await lifecycle.complete(1);
  assert.deepEqual(exits, [0]);
  assert.equal(process.listenerCount("SIGTERM"), listeners);
  assert.equal(input.listenerCount("end"), 0);
});

for (const [surface, event, origin] of [
  ["input", "close", "stdin_close"],
  ["input", "error", "input_error"],
  ["output", "close", "output_close"],
  ["output", "error", "output_error"],
] as const) {
  test(`protocol lifecycle attributes ${origin}`, async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const lifecycle = createProtocolProcessLifecycle({
      input,
      output,
      stderr: output,
      exitProcess: () => {},
    });
    (surface === "input" ? input : output).emit(event, new Error("io failure"));
    assert.equal(lifecycle.shutdownContext?.origin, origin);
    assert.equal(lifecycle.shutdownContext?.transportAvailable, false);
    await lifecycle.complete(0);
  });
}
