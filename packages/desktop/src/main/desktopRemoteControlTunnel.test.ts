import assert from "node:assert/strict";
import test from "node:test";
import {
  createRemoteControlTunnelSession,
  type RemoteControlTunnelDelegate,
  type RemoteControlTunnelSocket,
} from "./desktopRemoteControlTunnel.js";

/** 可手动推进的假时钟(替代真实 setTimeout/clearTimeout)。 */
function makeClock() {
  let seq = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  let nowMs = 0;
  return {
    now: () => nowMs,
    setTimeout(callback: () => void, ms: number) {
      const id = ++seq;
      timers.set(id, { at: nowMs + ms, callback });
      return { unref() {} } as unknown as NodeJS.Timeout;
    },
    clearTimeout(timer: NodeJS.Timeout) {
      timers.delete((timer as unknown as { id: number }).id);
    },
    advance(ms: number) {
      nowMs += ms;
      // 快照后遍历:回调内可能再次登记/清除计时器,避免边遍历边变更。
      for (const [id, timer] of Array.from(timers.entries())) {
        if (timer.at <= nowMs) {
          timers.delete(id);
          timer.callback();
        }
      }
    },
    pendingCount: () => timers.size,
  };
}

/** 记录行为的假 socket;测试通过暴露的钩子模拟 Worker 侧事件。 */
interface RecordedSocket extends RemoteControlTunnelSocket {
  id: number;
  emitOpen(): void;
  emitText(text: string): void;
  emitBinary(data: Uint8Array): void;
  emitClose(code: number, reason: string): void;
  emitUpgradeRejected(statusCode: number): void;
  sentText: string[];
  sentBinary: Uint8Array[];
  closed: Array<{ code: number; reason: string }>;
  readPaused: boolean;
}

function makeSocketFactory() {
  let seq = 0;
  const sockets: RecordedSocket[] = [];
  const urls: string[] = [];
  const headers: Record<string, string>[] = [];
  return {
    sockets,
    urls,
    headers,
    createSocket: (url: string, requestHeaders: Record<string, string>): RemoteControlTunnelSocket => {
      const id = ++seq;
      urls.push(url);
      headers.push(requestHeaders);
      const sentText: string[] = [];
      const sentBinary: Uint8Array[] = [];
      const closed: Array<{ code: number; reason: string }> = [];
      let onOpenCb: (() => void) | undefined;
      let onTextCb: ((data: string) => void) | undefined;
      let onBinaryCb: ((data: Uint8Array) => void) | undefined;
      let onCloseCb: ((code: number, reason: string) => void) | undefined;
      let onUpgradeRejectedCb: ((statusCode: number) => void) | undefined;
      const socket: RecordedSocket = {
        id,
        sentText,
        sentBinary,
        closed,
        readPaused: false,
        sendText: (data) => sentText.push(data),
        sendBinary: (data) => sentBinary.push(data),
        close: (code, reason) => closed.push({ code, reason }),
        onOpen: (listener) => {
          onOpenCb = listener;
        },
        onText: (listener) => {
          onTextCb = listener;
        },
        onBinary: (listener) => {
          onBinaryCb = listener;
        },
        onClose: (listener) => {
          onCloseCb = listener;
        },
        onError: () => {},
        onUpgradeRejected: (listener) => {
          onUpgradeRejectedCb = listener;
        },
        emitOpen: () => onOpenCb?.(),
        emitText: (text) => onTextCb?.(text),
        emitBinary: (data) => onBinaryCb?.(data),
        emitClose: (code, reason) => onCloseCb?.(code, reason),
        emitUpgradeRejected: (statusCode) => onUpgradeRejectedCb?.(statusCode),
        setReadPaused: (paused: boolean) => {
          socket.readPaused = paused;
        },
      };
      sockets.push(socket);
      return socket;
    },
  };
}

function baseParams() {
  return {
    workerBaseUrl: "https://tunnel.example.com",
    accessKey: "ak_test_access_key_value_123456",
    roomId: "roomId-00000000",
    capHash: "caphash-00000000",
    ttlMs: 300_000,
    devices: [{ deviceId: "device-1", credHash: "credhash-1", deviceName: "Phone" }],
  };
}

function makeDelegate() {
  const events: Array<{ kind: string; payload?: unknown }> = [];
  const delegate: RemoteControlTunnelDelegate = {
    onRoomReady: (frame) => events.push({ kind: "room.ready", payload: frame }),
    onPairingRequested: (frame) => events.push({ kind: "pairing.requested", payload: frame }),
    onPairingAccepted: (frame) => events.push({ kind: "pairing.accepted", payload: frame }),
    onBridgeOpen: (frame) => events.push({ kind: "bridge.open", payload: frame }),
    onBridgeDetached: (frame) => events.push({ kind: "bridge.detached", payload: frame }),
    onPeerDisconnected: (frame) => events.push({ kind: "peer.disconnected", payload: frame }),
    onRoomInvalidated: (frame) => events.push({ kind: "room.invalidated", payload: frame }),
    onRoomExpired: (frame) => events.push({ kind: "room.expired", payload: frame }),
    onProtocolError: (frame) => events.push({ kind: "error", payload: frame }),
    onAuthRejected: () => events.push({ kind: "auth-rejected" }),
    onTransportSuspended: (info) => events.push({ kind: "suspended", payload: info }),
    onClosed: (info) => events.push({ kind: "closed", payload: info }),
    onBridgeBinary: (data) => events.push({ kind: "bridge-binary", payload: data }),
  };
  return { events, delegate };
}

test("升级 URL 携带接入 Key header 与 roomId;open 后首帧为 proto:1 的 room.create 并启动心跳", () => {
  const factory = makeSocketFactory();
  const clock = makeClock();
  const { events, delegate } = makeDelegate();
  const session = createRemoteControlTunnelSession(baseParams(), delegate, {
    createSocket: factory.createSocket,
    setTimeoutImpl: clock.setTimeout,
    clearTimeoutImpl: clock.clearTimeout,
    nowImpl: clock.now,
  });
  assert.equal(factory.urls[0], "https://tunnel.example.com/connect/host?roomId=roomId-00000000");
  assert.equal(factory.headers[0]!["x-lcode-remote-access-key"], "ak_test_access_key_value_123456");

  factory.sockets[0]!.emitOpen();
  const firstFrame = JSON.parse(factory.sockets[0]!.sentText[0]!) as Record<string, unknown>;
  assert.equal(firstFrame.type, "room.create");
  assert.equal(firstFrame.proto, 1);
  assert.equal(firstFrame.roomId, "roomId-00000000");
  assert.equal(firstFrame.capHash, "caphash-00000000");
  assert.equal(firstFrame.ttlMs, 300_000);
  assert.deepEqual(firstFrame.devices, [
    { deviceId: "device-1", credHash: "credhash-1", deviceName: "Phone" },
  ]);

  clock.advance(30_000);
  assert.equal(JSON.parse(factory.sockets[0]!.sentText[1]!).type, "ping");
  assert.equal(events.length, 0);
  session.dispose();
});

test("room.ready/pairing.requested → accept 幂等;reject 携带 reason", () => {
  const factory = makeSocketFactory();
  const clock = makeClock();
  const { events, delegate } = makeDelegate();
  const session = createRemoteControlTunnelSession(baseParams(), delegate, {
    createSocket: factory.createSocket,
    setTimeoutImpl: clock.setTimeout,
    clearTimeoutImpl: clock.clearTimeout,
    nowImpl: clock.now,
  });
  const socket = factory.sockets[0]!;
  socket.emitOpen();

  socket.emitText(
    JSON.stringify({ type: "room.ready", proto: 1, roomId: "roomId-00000000", expiresAt: 123 }),
  );
  socket.emitText(
    JSON.stringify({
      type: "pairing.requested",
      proto: 1,
      requestId: "req-1",
      roomId: "roomId-00000000",
      deviceName: "Phone",
      ua: "UA",
    }),
  );
  session.decide("req-1", true);
  session.decide("req-1", true); // 同一 requestId 只生效一次(§2.2)
  const accepts = socket.sentText
    .map((text) => JSON.parse(text) as Record<string, unknown>)
    .filter((frame) => frame.type === "pairing.accept");
  assert.equal(accepts.length, 1);
  assert.equal(accepts[0]!.requestId, "req-1");

  socket.emitText(
    JSON.stringify({
      type: "pairing.requested",
      proto: 1,
      requestId: "req-2",
      roomId: "roomId-00000000",
      deviceName: "Phone",
      ua: "UA",
    }),
  );
  session.decide("req-2", false, "no");
  const rejects = socket.sentText
    .map((text) => JSON.parse(text) as Record<string, unknown>)
    .filter((frame) => frame.type === "pairing.reject");
  assert.equal(rejects.length, 1);
  assert.equal(rejects[0]!.reason, "no");
  assert.ok(events.some((event) => event.kind === "room.ready"));
  assert.ok(events.some((event) => event.kind === "pairing.requested"));
  session.dispose();
});

test("bridge.open 后二进制双向可用;桥接前二进制被丢弃", () => {
  const factory = makeSocketFactory();
  const clock = makeClock();
  const { events, delegate } = makeDelegate();
  const session = createRemoteControlTunnelSession(baseParams(), delegate, {
    createSocket: factory.createSocket,
    setTimeoutImpl: clock.setTimeout,
    clearTimeoutImpl: clock.clearTimeout,
    nowImpl: clock.now,
  });
  const socket = factory.sockets[0]!;
  socket.emitOpen();

  const phoneFrame = encodeFrame(new Uint8Array([7, 7]));
  socket.emitBinary(phoneFrame);
  assert.ok(!events.some((event) => event.kind === "bridge-binary"));

  socket.emitText(JSON.stringify({ type: "bridge.open", proto: 1, deviceId: "device-1", resumed: false }));
  socket.emitBinary(phoneFrame);
  assert.ok(events.some((event) => event.kind === "bridge.open"));

  session.sendBridgeBinary(new Uint8Array([8, 8]));
  // sendBridgeBinary 是帧泵已包帧数据的透传口(封装唯一发生在帧泵,§6.4)。
  assert.equal(socket.sentBinary.length, 1);
  assert.deepEqual([...socket.sentBinary[0]!], [8, 8]);
  assert.ok(session.isBridged());
  session.dispose();
});

test("device.revoke 与 room.stop 语义:stop 发送后 1000 关闭且不再重连", () => {
  const factory = makeSocketFactory();
  const clock = makeClock();
  const { events, delegate } = makeDelegate();
  const session = createRemoteControlTunnelSession(baseParams(), delegate, {
    createSocket: factory.createSocket,
    setTimeoutImpl: clock.setTimeout,
    clearTimeoutImpl: clock.clearTimeout,
    nowImpl: clock.now,
  });
  const socket = factory.sockets[0]!;
  socket.emitOpen();
  session.revokeDevice("device-9");
  assert.equal(JSON.parse(socket.sentText[1]!).type, "device.revoke");

  session.stopRoom();
  assert.equal(JSON.parse(socket.sentText[2]!).type, "room.stop");
  assert.deepEqual(socket.closed, [{ code: 1000, reason: "room stopped by desktop" }]);
  socket.emitClose(1000, "room stopped by desktop");
  assert.ok(!factory.urls.includes("second") && factory.sockets.length === 1);
  assert.ok(events.some((event) => event.kind === "closed" && (event.payload as { code: number }).code === 1000));
  assert.equal(session.isRunning(), false);
});

test("意外断开进入 30s 宽限重连;终态 close code 不重连", () => {
  const factory = makeSocketFactory();
  const clock = makeClock();
  const { events, delegate } = makeDelegate();
  const session = createRemoteControlTunnelSession(baseParams(), delegate, {
    createSocket: factory.createSocket,
    setTimeoutImpl: clock.setTimeout,
    clearTimeoutImpl: clock.clearTimeout,
    nowImpl: clock.now,
  });
  factory.sockets[0]!.emitOpen();
  factory.sockets[0]!.emitText(
    JSON.stringify({ type: "room.ready", proto: 1, roomId: "roomId-00000000", expiresAt: 123 }),
  );
  factory.sockets[0]!.emitClose(1006, "net drop");
  assert.ok(events.some((event) => event.kind === "suspended"));
  clock.advance(2_000);
  assert.equal(factory.sockets.length, 2);
  factory.sockets[1]!.emitOpen();
  // 重连成功后重发幂等 room.create(§3.3)。
  assert.equal(JSON.parse(factory.sockets[1]!.sentText[0]!).type, "room.create");

  factory.sockets[1]!.emitClose(4006, "invalidated");
  const closedEvents = events.filter((event) => event.kind === "closed");
  assert.equal(closedEvents.length, 1);
  clock.advance(60_000);
  assert.equal(factory.sockets.length, 2); // 终态不再新建连接
  assert.equal(session.isRunning(), false);
});

test("room.ready 重置宽限截止:久连后的再次断开重新获得完整 30s 宽限(§3.3)", () => {
  const factory = makeSocketFactory();
  const clock = makeClock();
  const { events, delegate } = makeDelegate();
  const session = createRemoteControlTunnelSession(baseParams(), delegate, {
    createSocket: factory.createSocket,
    setTimeoutImpl: clock.setTimeout,
    clearTimeoutImpl: clock.clearTimeout,
    nowImpl: clock.now,
  });
  factory.sockets[0]!.emitOpen();
  factory.sockets[0]!.emitText(
    JSON.stringify({ type: "room.ready", proto: 1, roomId: "roomId-00000000", expiresAt: 123 }),
  );
  factory.sockets[0]!.emitClose(1006, "first drop");
  clock.advance(2_000);
  factory.sockets[1]!.emitOpen();
  factory.sockets[1]!.emitText(
    JSON.stringify({ type: "room.ready", proto: 1, roomId: "roomId-00000000", expiresAt: 123 }),
  );
  // 重连成功后长稳 10 分钟,再断开必须重新获得 30s 宽限,而不是立即判"宽限耗尽"。
  clock.advance(600_000);
  factory.sockets[1]!.emitClose(1006, "second drop");
  assert.ok(events.some((event) => event.kind === "suspended"));
  clock.advance(2_000);
  assert.equal(factory.sockets.length, 3);
  assert.equal(session.isRunning(), true);
  const closedEvents = events.filter((event) => event.kind === "closed");
  assert.equal(closedEvents.length, 0);
  session.dispose();
});

test("宽限窗口内 decide 入队,重连成功后随 room.create 补发", () => {
  const factory = makeSocketFactory();
  const clock = makeClock();
  const { delegate } = makeDelegate();
  const session = createRemoteControlTunnelSession(baseParams(), delegate, {
    createSocket: factory.createSocket,
    setTimeoutImpl: clock.setTimeout,
    clearTimeoutImpl: clock.clearTimeout,
    nowImpl: clock.now,
  });
  factory.sockets[0]!.emitOpen();
  factory.sockets[0]!.emitText(
    JSON.stringify({ type: "room.ready", proto: 1, roomId: "roomId-00000000", expiresAt: 123 }),
  );
  factory.sockets[0]!.emitText(
    JSON.stringify({
      type: "pairing.requested",
      proto: 1,
      requestId: "req-1",
      roomId: "roomId-00000000",
      deviceName: "Phone",
      ua: "UA",
    }),
  );
  // 断开进入宽限窗口,用户此时点"允许":socket 为空,裁决不得被静默丢弃。
  factory.sockets[0]!.emitClose(1006, "net drop");
  session.decide("req-1", true);
  assert.equal(factory.sockets[0]!.sentText.filter((t) => t.includes("pairing.accept")).length, 0);

  clock.advance(2_000);
  factory.sockets[1]!.emitOpen();
  // 补发顺序:room.create 在前,排队裁决在后。
  assert.equal(JSON.parse(factory.sockets[1]!.sentText[0]!).type, "room.create");
  const flushed = JSON.parse(factory.sockets[1]!.sentText[1]!) as Record<string, unknown>;
  assert.equal(flushed.type, "pairing.accept");
  assert.equal(flushed.requestId, "req-1");
  session.dispose();
});

test("宽限窗口内 revoke 入队:重连后 room.create 不含被吊销设备并补发 device.revoke", () => {
  const factory = makeSocketFactory();
  const clock = makeClock();
  const { delegate } = makeDelegate();
  const session = createRemoteControlTunnelSession(baseParams(), delegate, {
    createSocket: factory.createSocket,
    setTimeoutImpl: clock.setTimeout,
    clearTimeoutImpl: clock.clearTimeout,
    nowImpl: clock.now,
  });
  factory.sockets[0]!.emitOpen();
  factory.sockets[0]!.emitText(
    JSON.stringify({ type: "room.ready", proto: 1, roomId: "roomId-00000000", expiresAt: 123 }),
  );
  factory.sockets[0]!.emitClose(1006, "net drop");
  // 断开窗口内吊销:不得丢帧,也不得让 credHash 随重连的 room.create 复活(§4.3.3)。
  session.revokeDevice("device-1");

  clock.advance(2_000);
  factory.sockets[1]!.emitOpen();
  const recreated = JSON.parse(factory.sockets[1]!.sentText[0]!) as Record<string, unknown>;
  assert.equal(recreated.type, "room.create");
  assert.deepEqual(recreated.devices, []);
  const flushed = JSON.parse(factory.sockets[1]!.sentText[1]!) as Record<string, unknown>;
  assert.equal(flushed.type, "device.revoke");
  assert.equal(flushed.deviceId, "device-1");
  session.dispose();
});

test("socket 在线时 revoke 立即发送;此后重连的 room.create 也不含该设备", () => {
  const factory = makeSocketFactory();
  const clock = makeClock();
  const { delegate } = makeDelegate();
  const session = createRemoteControlTunnelSession(baseParams(), delegate, {
    createSocket: factory.createSocket,
    setTimeoutImpl: clock.setTimeout,
    clearTimeoutImpl: clock.clearTimeout,
    nowImpl: clock.now,
  });
  factory.sockets[0]!.emitOpen();
  factory.sockets[0]!.emitText(
    JSON.stringify({ type: "room.ready", proto: 1, roomId: "roomId-00000000", expiresAt: 123 }),
  );
  session.revokeDevice("device-1");
  const revoked = JSON.parse(factory.sockets[0]!.sentText[1]!) as Record<string, unknown>;
  assert.equal(revoked.type, "device.revoke");
  assert.equal(revoked.deviceId, "device-1");

  factory.sockets[0]!.emitClose(1006, "net drop");
  clock.advance(2_000);
  factory.sockets[1]!.emitOpen();
  const recreated = JSON.parse(factory.sockets[1]!.sentText[0]!) as Record<string, unknown>;
  assert.deepEqual(recreated.devices, []);
  // 已在线送达的 revoke 不重复入队补发。
  assert.equal(factory.sockets[1]!.sentText.length, 1);
  session.dispose();
});

test("transportPaused 跨重连保持:新 socket 建立后恢复暂停(§6.4 反压)", () => {
  const factory = makeSocketFactory();
  const clock = makeClock();
  const { delegate } = makeDelegate();
  const session = createRemoteControlTunnelSession(baseParams(), delegate, {
    createSocket: factory.createSocket,
    setTimeoutImpl: clock.setTimeout,
    clearTimeoutImpl: clock.clearTimeout,
    nowImpl: clock.now,
  });
  factory.sockets[0]!.emitOpen();
  factory.sockets[0]!.emitText(
    JSON.stringify({ type: "room.ready", proto: 1, roomId: "roomId-00000000", expiresAt: 123 }),
  );
  session.setTransportPaused(true);
  assert.equal(factory.sockets[0]!.readPaused, true);

  factory.sockets[0]!.emitClose(1006, "net drop");
  clock.advance(2_000);
  factory.sockets[1]!.emitOpen();
  assert.equal(factory.sockets[1]!.readPaused, true);

  session.setTransportPaused(false);
  assert.equal(factory.sockets[1]!.readPaused, false);
  session.dispose();
});

test("bridge.open 之前 host socket 反复收到 BINARY:计数达阈值即 4003 断开", () => {
  const factory = makeSocketFactory();
  const clock = makeClock();
  const { delegate } = makeDelegate();
  const session = createRemoteControlTunnelSession(baseParams(), delegate, {
    createSocket: factory.createSocket,
    setTimeoutImpl: clock.setTimeout,
    clearTimeoutImpl: clock.clearTimeout,
    nowImpl: clock.now,
  });
  const socket = factory.sockets[0]!;
  socket.emitOpen();
  for (let i = 0; i < 4; i += 1) {
    socket.emitBinary(new Uint8Array([1]));
  }
  assert.equal(socket.closed.length, 0);
  socket.emitBinary(new Uint8Array([1]));
  assert.deepEqual(socket.closed, [{ code: 4003, reason: "binary frame before bridge.open" }]);
  socket.emitClose(4003, "binary frame before bridge.open");
  assert.equal(session.isRunning(), false);
  clock.advance(60_000);
  assert.equal(factory.sockets.length, 1);
});

test("宽限耗尽后放弃重连并上报终态", () => {
  const factory = makeSocketFactory();
  const clock = makeClock();
  const { events, delegate } = makeDelegate();
  const session = createRemoteControlTunnelSession(baseParams(), delegate, {
    createSocket: factory.createSocket,
    setTimeoutImpl: clock.setTimeout,
    clearTimeoutImpl: clock.clearTimeout,
    nowImpl: clock.now,
  });
  factory.sockets[0]!.emitOpen();
  factory.sockets[0]!.emitText(
    JSON.stringify({ type: "room.ready", proto: 1, roomId: "roomId-00000000", expiresAt: 123 }),
  );
  factory.sockets[0]!.emitClose(1006, "net drop");
  for (let i = 0; i < 14; i += 1) {
    clock.advance(2_000);
    const socket = factory.sockets[factory.sockets.length - 1]!;
    socket.emitClose(1006, "net drop");
  }
  // 30s 宽限耗尽:最后一次挂起的重连计时器到点后放弃并上报终态。
  clock.advance(2_000);
  const closedEvents = events.filter((event) => event.kind === "closed");
  assert.equal(closedEvents.length, 1);
  assert.equal(session.isRunning(), false);
  const socketsBefore = factory.sockets.length;
  clock.advance(60_000);
  assert.equal(factory.sockets.length, socketsBefore);
});

test("升级 401 拒绝:不重连并上报 auth-rejected", () => {
  const factory = makeSocketFactory();
  const clock = makeClock();
  const { events, delegate } = makeDelegate();
  createRemoteControlTunnelSession(baseParams(), delegate, {
    createSocket: factory.createSocket,
    setTimeoutImpl: clock.setTimeout,
    clearTimeoutImpl: clock.clearTimeout,
    nowImpl: clock.now,
  });
  factory.sockets[0]!.emitUpgradeRejected(401);
  assert.ok(events.some((event) => event.kind === "auth-rejected"));
  clock.advance(60_000);
  assert.equal(factory.sockets.length, 1);
});

test("非 JSON TEXT 按 4003 违规关闭", () => {
  const factory = makeSocketFactory();
  const clock = makeClock();
  const { events, delegate } = makeDelegate();
  const session = createRemoteControlTunnelSession(baseParams(), delegate, {
    createSocket: factory.createSocket,
    setTimeoutImpl: clock.setTimeout,
    clearTimeoutImpl: clock.clearTimeout,
    nowImpl: clock.now,
  });
  const socket = factory.sockets[0]!;
  socket.emitOpen();
  socket.emitText("not-json");
  assert.deepEqual(socket.closed, [{ code: 4003, reason: "invalid control frame" }]);
  // 真实 ws 在 close() 后会触发 close 事件;4003 是终态,不重连。
  socket.emitClose(4003, "invalid control frame");
  assert.equal(session.isRunning(), false);
  assert.ok(events.some((event) => event.kind === "closed"));
});

/** 与 packages/rpc SocketProtocol 同构的 Regular 帧编码(测试辅助)。 */
function encodeFrame(payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(13 + payload.byteLength);
  frame[0] = 1;
  new DataView(frame.buffer).setUint32(9, payload.byteLength);
  frame.set(payload, 13);
  return frame;
}
