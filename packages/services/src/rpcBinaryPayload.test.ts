import assert from "node:assert/strict";
import test from "node:test";
import { MessagePortProtocol, type MessagePortLike, type MessagePortPayload } from "@lcode/rpc";

test("large binary RPC payloads bypass control-object key enumeration", () => {
  let receive: ((event: { data: MessagePortPayload }) => void) | undefined;
  const port: MessagePortLike = {
    addEventListener: (_type, listener) => {
      receive = listener;
    },
    removeEventListener: (_type, listener) => {
      if (receive === listener) receive = undefined;
    },
    postMessage: () => {},
    start: () => {},
    close: () => {},
  };
  const protocol = new MessagePortProtocol(port);
  const received: Uint8Array[] = [];
  const states: string[] = [];
  protocol.onMessage((message) => received.push(message.buffer));
  protocol.onFlowState((state) => states.push(state));
  const payload = new Proxy(new Uint8Array(32 * 1024 * 1024), {
    ownKeys: () => {
      throw new Error("binary payload indices must not be enumerated");
    },
    get: (target, key) => Reflect.get(target, key, target),
  });
  receive!({ data: payload });
  assert.equal(received.length, 1);
  assert.equal(received[0], payload);
  assert.equal(received[0]?.byteLength, 32 * 1024 * 1024);
  receive!({ data: { __lcodeRpcControl: "connection-flow-v1", state: "saturated" } });
  receive!({ data: { __lcodeRpcControl: "connection-flow-v1", state: "drained" } });
  receive!({
    data: {
      __lcodeRpcControl: "connection-flow-v1",
      state: "drained",
      extra: true,
    } as MessagePortPayload,
  });
  receive!({
    data: {
      __lcodeRpcControl: "connection-flow-v1",
      state: "unknown",
    } as unknown as MessagePortPayload,
  });
  assert.deepEqual(states, ["saturated", "drained"]);
  assert.equal(received.length, 1);
  protocol.disconnect();
  assert.equal(receive, undefined);
});
