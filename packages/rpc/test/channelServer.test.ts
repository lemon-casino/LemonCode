import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ChannelServer } from "../src/channelServer.js";
import { RequestType, ResponseType } from "../src/channels.shared.js";
import { VSBuffer } from "../src/buffer.js";
import { BufferReader, BufferWriter, deserialize, serialize } from "../src/serialization.js";
import type { Event } from "../src/foundation.js";

for (const pending of [false, true]) {
  test(`event subscription failures are isolated (pending=${pending})`, async (t) => {
    const warnings = t.mock.method(console, "warn", () => {});
    let receive!: (message: VSBuffer) => void;
    const sent: { header: number[]; body: unknown }[] = [];
    const server = new ChannelServer(
      {
        onMessage: (listener) => {
          receive = listener;
          return { dispose() {} };
        },
        send: (message) => {
          const reader = new BufferReader(message);
          sent.push({ header: deserialize(reader), body: deserialize(reader) });
        },
      },
      "test",
      1000,
    );
    t.after(() => server.dispose());
    function request(type: RequestType, id: number, name = "allowed") {
      const writer = new BufferWriter();
      serialize(writer, [type, id, "scoped", name]);
      serialize(writer, { privateValue: "must-not-be-logged" });
      receive(writer.buffer);
    }
    let disposed = 0;
    const channel = {
      call: async <T>() => "ok" as T,
      listen: <T>(_context: string, name: string): Event<T> => {
        if (name === "denied") throw new Error("must-not-be-logged");
        return (listener) => {
          if (name === "registration-failure") throw new Error("must-not-be-logged");
          listener("event" as T);
          return {
            dispose: () => {
              disposed++;
            },
          };
        };
      },
    };
    if (!pending) server.registerChannel("scoped", channel);
    assert.doesNotThrow(() => request(RequestType.EventListen, 1, "denied"));
    assert.doesNotThrow(() => request(RequestType.EventListen, 2, "registration-failure"));
    request(RequestType.EventListen, 3);
    if (pending) server.registerChannel("scoped", channel);
    await delay(10);
    assert.equal(warnings.mock.callCount(), 2);
    assert.ok(!JSON.stringify(warnings.mock.calls).includes("must-not-be-logged"));
    assert.deepEqual(
      sent.filter(({ header }) => header[0] === ResponseType.EventFire),
      [{ header: [ResponseType.EventFire, 3], body: "event" }],
    );
    request(RequestType.EventDispose, 1);
    request(RequestType.EventDispose, 2);
    assert.equal(disposed, 0);
    request(RequestType.EventDispose, 3);
    request(RequestType.EventDispose, 3);
    assert.equal(disposed, 1);
    request(RequestType.Promise, 4);
    await delay(0);
    assert.ok(
      sent.some(
        ({ header, body }) =>
          header[0] === ResponseType.PromiseSuccess && header[1] === 4 && body === "ok",
      ),
    );
  });
}
