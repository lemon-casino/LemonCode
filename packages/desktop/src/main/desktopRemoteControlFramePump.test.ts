import assert from "node:assert/strict";
import test from "node:test";
import {
  REMOTE_CONTROL_WS_HEADER_SIZE,
  createRemoteControlFramePump,
  encodeRemoteControlRegularFrame,
  type RemoteControlFramePumpWsSide,
} from "./desktopRemoteControlFramePump.js";

function makeWsSide() {
  const sent: Uint8Array[] = [];
  const closes: Array<{ code: number; reason: string }> = [];
  const ws: RemoteControlFramePumpWsSide = {
    sendBinary: (data) => sent.push(data),
    close: (code, reason) => closes.push({ code, reason }),
  };
  return { ws, sent, closes };
}

function makePortSide() {
  const posted: Uint8Array[] = [];
  return { port: { postMessage: (data: Uint8Array) => posted.push(data) }, posted };
}

test("帧泵把合法 Regular 帧剥头后转发到 port", () => {
  const { ws, sent } = makeWsSide();
  const { port, posted } = makePortSide();
  const pauses: boolean[] = [];
  const pump = createRemoteControlFramePump({ ws, port, setTransportPaused: (p) => pauses.push(p) });
  const payload = new Uint8Array([9, 8, 7, 6]);
  pump.handleWsBinary(encodeRemoteControlRegularFrame(payload));
  assert.equal(posted.length, 1);
  assert.deepEqual([...posted[0]!], [...payload]);
  assert.equal(sent.length, 0);
  assert.equal(pauses.length, 0);
});

test("帧泵丢弃短帧/非 Regular 帧/长度不匹配帧/超限帧并计数", () => {
  const { ws, closes } = makeWsSide();
  const { port, posted } = makePortSide();
  const violations: string[] = [];
  const pump = createRemoteControlFramePump({ ws, port, onViolation: (v) => violations.push(v.reason) });

  pump.handleWsBinary(new Uint8Array(5));
  const badType = new Uint8Array(REMOTE_CONTROL_WS_HEADER_SIZE + 2);
  badType[0] = 2; // Control,不是 Regular
  pump.handleWsBinary(badType);
  const mismatch = new Uint8Array(REMOTE_CONTROL_WS_HEADER_SIZE + 4);
  mismatch[0] = 1;
  new DataView(mismatch.buffer).setUint32(9, 9); // 声明 9 字节 payload,实际 4
  pump.handleWsBinary(mismatch);
  const oversized = new Uint8Array(REMOTE_CONTROL_WS_HEADER_SIZE + 2 * 1024 * 1024);
  oversized[0] = 1;
  new DataView(oversized.buffer).setUint32(9, 2 * 1024 * 1024); // 长度字段与实际一致,但超 1 MiB 上限
  pump.handleWsBinary(oversized);

  assert.equal(posted.length, 0);
  assert.deepEqual(violations, [
    "frame-shorter-than-header",
    "unsupported-frame-type-2",
    "frame-length-mismatch",
    "frame-exceeds-limit",
  ]);
  // 连续违规未达阈值(默认 5),不断开。
  assert.equal(closes.length, 0);
});

test("连续违规达到阈值后关闭 WS 并回调 onViolationLimit;合法帧重置计数", () => {
  const { ws, closes } = makeWsSide();
  const { port } = makePortSide();
  let limitFired = 0;
  const pump = createRemoteControlFramePump({
    ws,
    port,
    onViolationLimit: () => {
      limitFired += 1;
    },
  });
  const bad = new Uint8Array(REMOTE_CONTROL_WS_HEADER_SIZE);
  for (let i = 0; i < 3; i += 1) {
    pump.handleWsBinary(bad);
  }
  // 一个合法帧把"连续"计数清零。
  pump.handleWsBinary(encodeRemoteControlRegularFrame(new Uint8Array([1])));
  for (let i = 0; i < 4; i += 1) {
    pump.handleWsBinary(bad);
  }
  assert.equal(limitFired, 0);
  pump.handleWsBinary(bad);
  assert.equal(limitFired, 1);
  assert.deepEqual(closes, [{ code: 4003, reason: "frame-pump protocol violation" }]);
});

test("port 的 Uint8Array 被包成 Regular 帧写入 WS", () => {
  const { ws, sent } = makeWsSide();
  const { port } = makePortSide();
  const pump = createRemoteControlFramePump({ ws, port });
  const payload = new Uint8Array([1, 2, 3]);
  pump.handlePortMessage(payload);
  assert.equal(sent.length, 1);
  const frame = sent[0]!;
  assert.equal(frame[0], 1); // Regular
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  assert.equal(view.getUint32(1), 0); // id
  assert.equal(view.getUint32(5), 0); // ack
  assert.equal(view.getUint32(9), payload.byteLength);
  assert.deepEqual([...frame.subarray(REMOTE_CONTROL_WS_HEADER_SIZE)], [...payload]);
});

test("port 流控对象不穿越 WS,只驱动反压边沿", () => {
  const { ws, sent } = makeWsSide();
  const { port } = makePortSide();
  const pauses: boolean[] = [];
  const pump = createRemoteControlFramePump({ ws, port, setTransportPaused: (p) => pauses.push(p) });
  pump.handlePortMessage({ __lcodeRpcControl: "connection-flow-v1", state: "saturated" });
  assert.deepEqual(pauses, [true]);
  pump.handlePortMessage({ __lcodeRpcControl: "connection-flow-v1", state: "saturated" });
  assert.deepEqual(pauses, [true]); // 同一边沿不重复
  pump.handlePortMessage({ __lcodeRpcControl: "connection-flow-v1", state: "drained" });
  assert.deepEqual(pauses, [true, false]);
  assert.equal(sent.length, 0);
});

test("port 上的非二进制消息按违规处理", () => {
  const { ws, sent } = makeWsSide();
  const { port } = makePortSide();
  let limitFired = 0;
  const pump = createRemoteControlFramePump({
    ws,
    port,
    maxConsecutiveViolations: 2,
    onViolationLimit: () => {
      limitFired += 1;
    },
  });
  pump.handlePortMessage("hello");
  pump.handlePortMessage({ foo: 1 });
  assert.equal(limitFired, 1);
  assert.equal(sent.length, 0);
});

test("stop 后幂等忽略两侧输入并解除反压", () => {
  const { ws, sent, closes } = makeWsSide();
  const { port, posted } = makePortSide();
  const pauses: boolean[] = [];
  const pump = createRemoteControlFramePump({ ws, port, setTransportPaused: (p) => pauses.push(p) });
  pump.handlePortMessage({ __lcodeRpcControl: "connection-flow-v1", state: "saturated" });
  pump.stop();
  pump.stop();
  pump.handleWsBinary(encodeRemoteControlRegularFrame(new Uint8Array([1])));
  pump.handlePortMessage(new Uint8Array([1]));
  assert.equal(posted.length, 0);
  assert.equal(sent.length, 0);
  assert.equal(closes.length, 0);
  assert.ok(pump.isStopped());
  // 停泵时若处于暂停态,应恢复底层读。
  assert.ok(pauses.includes(false));
});
