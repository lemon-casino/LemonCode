import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { SqliteSessionStore } from "@lcode/adapters/storage";
import { prepareProtocolStartupStorage } from "./storage-startup.js";

function createTransport(options: { reuse?: boolean; failFailureNotification?: boolean } = {}) {
  const input = new PassThrough();
  const frames: Array<{ method: string; params: Record<string, unknown> }> = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      const frame = JSON.parse(String(chunk)) as (typeof frames)[number];
      frames.push(frame);
      if (frame.method === "startup/storagePath") {
        queueMicrotask(() =>
          input.write(
            `${JSON.stringify({ method: "startup/storagePathReady", reuse: options.reuse ?? false })}\n`,
          ),
        );
      }
      callback(
        options.failFailureNotification && frame.params.phase === "failed"
          ? new Error("Failure notification unavailable")
          : undefined,
      );
    },
  });
  output.on("error", () => undefined);
  return { input, output, frames };
}

for (const [label, primary] of [
  ["Error", new Error("Primary close failure")],
  ["zero", 0],
  ["false", false],
  ["empty string", ""],
  ["null", null],
  ["undefined", undefined],
] as const) {
  test(`storage preparation preserves ${label} as primary failure when cleanup also fails`, async (t) => {
    const transport = createTransport();
    let closeCalls = 0;
    t.mock.method(SqliteSessionStore, "openStartup", async () => ({
      close() {
        closeCalls += 1;
        throw closeCalls === 1 ? primary : new Error("Secondary close failure");
      },
    }));

    await assert.rejects(
      prepareProtocolStartupStorage({ dbPath: "fixture-session.db", ...transport }),
      (error: unknown) => Object.is(error, primary),
    );
    assert.equal(closeCalls, 2);
    assert.equal(
      transport.frames.some((frame) => frame.method === "startup/storagePrepared"),
      false,
    );
    assert.equal(transport.frames.at(-1)?.params.phase, "failed");
    transport.input.destroy();
    transport.output.destroy();
  });
}

test("storage preparation closes before prepared and reuse does not open a store", async (t) => {
  let opened = 0;
  let closed = 0;
  t.mock.method(SqliteSessionStore, "openStartup", async () => {
    opened += 1;
    return {
      close: () => {
        closed += 1;
      },
    };
  });
  for (const reuse of [false, true]) {
    const transport = createTransport({ reuse });
    await prepareProtocolStartupStorage({ dbPath: "fixture-session.db", ...transport });
    assert.equal(transport.frames[0]?.method, "startup/storagePath");
    assert.equal(transport.frames.at(-1)?.method, "startup/storagePrepared");
    assert.equal(
      transport.frames.filter((frame) => frame.params.phase === "checking").length,
      reuse ? 0 : 1,
    );
    assert.equal(opened, 1);
    assert.equal(closed, 1);
    transport.input.destroy();
    transport.output.destroy();
  }
});

test("failure reporting cannot replace a storage failure", async (t) => {
  const primary = new Error("Startup failed");
  const transport = createTransport({ failFailureNotification: true });
  t.mock.method(SqliteSessionStore, "openStartup", async () => {
    throw primary;
  });
  await assert.rejects(
    prepareProtocolStartupStorage({ dbPath: "fixture-session.db", ...transport }),
    (error: unknown) => error === primary,
  );
  assert.equal(
    transport.frames.some((frame) => frame.method === "startup/storagePrepared"),
    false,
  );
  transport.input.destroy();
  transport.output.destroy();
});
