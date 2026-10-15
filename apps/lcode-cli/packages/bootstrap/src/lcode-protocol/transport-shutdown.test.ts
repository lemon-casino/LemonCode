import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { LCodeProtocolNdjsonConnection } from "./transport.js";

test("graceful abort keeps reverse ACK input alive until drain; EOF still closes immediately", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const controller = new AbortController();
  let complete!: () => void;
  const drain = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const received: unknown[] = [];
  let disconnects = 0;
  const connection = new LCodeProtocolNdjsonConnection({
    input,
    output,
    signal: controller.signal,
    drainOnAbort: () => drain,
    onTransportClosed: () => {
      disconnects += 1;
    },
    handleMessage: async (message) => {
      received.push(message);
      return undefined;
    },
  });
  connection.start();
  controller.abort();
  input.write('{"id":"old-cleanup","result":{"ok":true}}\n');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(received.length, 1);
  assert.equal(disconnects, 0);
  input.end();
  await connection.waitForClose();
  assert.equal(disconnects, 1);
  complete();
  await drain;
  input.destroy();
  output.destroy();
});
