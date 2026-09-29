import assert from "node:assert/strict";
import test from "node:test";
import type { RemoteControlPersistedDevice, RemotePairingStatePush } from "@lcode/shared";
import { DEFAULT_REMOTE_CONTROL_WORKER_BASE_URL } from "@lcode/shared";
import { createRemoteControlController } from "./desktopRemoteControlController.js";
import {
  REMOTE_CONTROL_ACCESS_KEY_CREDENTIAL_KEY,
  REMOTE_CONTROL_DEVICES_CREDENTIAL_KEY,
  type RemoteControlCredentialService,
} from "./desktopRemoteControlStore.js";
import type {
  RemoteControlTunnelSession,
  RemoteControlTunnelStartParams,
  RemoteControlTunnelDelegate,
} from "./desktopRemoteControlTunnel.js";
import { encodeRemoteControlRegularFrame } from "./desktopRemoteControlFramePump.js";

/** Map 版凭据存储(fake;键空间与 store 常量一致)。 */
function makeFakeCredentials() {
  const map = new Map<string, string>();
  const service: RemoteControlCredentialService = {
    load: async (key) => map.get(key) ?? null,
    save: async (key, value) => {
      map.set(key, value);
    },
    delete: async (key) => {
      map.delete(key);
    },
  };
  return { map, service };
}

/** 记录行为的假隧道会话;测试通过捕获的 delegate 驱动 Worker 侧事件。 */
interface FakeTunnel {
  session: RemoteControlTunnelSession;
  delegate: RemoteControlTunnelDelegate;
  params: RemoteControlTunnelStartParams;
  decided: Array<{ requestId: string; accept: boolean }>;
  revoked: string[];
  stopped: boolean;
  sentBinary: Uint8Array[];
}

function makeTunnelFactory() {
  const tunnels: FakeTunnel[] = [];
  const createTunnelSession = (
    params: RemoteControlTunnelStartParams,
    delegate: RemoteControlTunnelDelegate,
  ): RemoteControlTunnelSession => {
    const tunnel: FakeTunnel = {
      params,
      delegate,
      decided: [],
      revoked: [],
      stopped: false,
      sentBinary: [],
      session: {
        roomId: params.roomId,
        decide: (requestId, accept) => {
          tunnel.decided.push({ requestId, accept });
        },
        revokeDevice: (deviceId) => {
          tunnel.revoked.push(deviceId);
        },
        stopRoom: () => {
          tunnel.stopped = true;
        },
        close: () => {},
        sendBridgeBinary: (data) => {
          tunnel.sentBinary.push(data);
        },
        setTransportPaused: () => {},
        isBridged: () => false,
        isRunning: () => !tunnel.stopped,
        dispose: () => {},
      },
    };
    tunnels.push(tunnel);
    return tunnel.session;
  };
  return { tunnels, createTunnelSession };
}

/** 假 attachment:记录 attach 入参与 port/process 交互顺序。 */
function makeAttachOk() {
  const calls: Array<Record<string, unknown>> = [];
  const detachMessages: Array<Record<string, unknown>> = [];
  const postedToPort: Uint8Array[] = [];
  const portListeners = new Map<string, Array<(event: unknown) => void>>();
  const attachmentId = "attachment-1";
  const port = {
    on: (event: string, listener: (event: unknown) => void) => {
      const list = portListeners.get(event) ?? [];
      list.push(listener);
      portListeners.set(event, list);
      return port;
    },
    start: () => {},
    postMessage: (data: Uint8Array) => {
      postedToPort.push(data);
    },
    close: () => {},
  };
  const process = {
    postMessage: (message: Record<string, unknown>) => {
      detachMessages.push(message);
    },
  };
  const attach = (params: Record<string, unknown>) => {
    calls.push(params);
    return { process, port, remoteKind: "ssh", attachmentId };
  };
  function emitPortMessage(data: unknown): void {
    for (const listener of portListeners.get("message") ?? []) {
      listener({ data });
    }
  }
  return { attach, calls, detachMessages, postedToPort, emitPortMessage, attachmentId };
}

function makeController(options?: {
  attach?: ReturnType<typeof makeAttachOk>["attach"];
  attachLocal?: ReturnType<typeof makeAttachOk>["attach"];
}) {
  const { map, service } = makeFakeCredentials();
  const { tunnels, createTunnelSession } = makeTunnelFactory();
  const broadcasts: Array<{ channel: string; payload: RemotePairingStatePush }> = [];
  const okAttach = makeAttachOk();
  type AttachFn = NonNullable<
    Parameters<typeof createRemoteControlController>[0]["attachRemoteWorkspaceSessionHost"]
  >;
  type LocalAttachFn = NonNullable<
    Parameters<typeof createRemoteControlController>[0]["attachLocalWorkspaceSessionHost"]
  >;
  const controller = createRemoteControlController({
    logger: { info() {}, warn() {}, error() {} },
    credentialService: service,
    attachRemoteWorkspaceSessionHost: (options?.attach ?? okAttach.attach) as unknown as AttachFn,
    attachLocalWorkspaceSessionHost: (options?.attachLocal ??
      okAttach.attach) as unknown as LocalAttachFn,
    broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
    now: (() => {
      let t = 1_000_000;
      return () => (t += 1_000);
    })(),
    createTunnelSession: createTunnelSession as unknown as Parameters<
      typeof createRemoteControlController
    >[0]["createTunnelSession"],
  });
  return { controller, map, service, tunnels, broadcasts, okAttach };
}

const MIRROR_TARGET = {
  kind: "remote",
  windowId: 1,
  remoteSessionId: "rs-1",
  workspacePath: "/work",
  workspaceIdentity: "wi-1",
};

async function enableAndStart(
  controller: ReturnType<typeof makeController>["controller"],
  target?: typeof MIRROR_TARGET,
) {
  const setResult = await controller.setConfig({
    enabled: true,
    workerBaseUrl: "https://tunnel.example.com",
    accessKey: "ak-valid-key-123456789012345678901234567890",
  });
  assert.deepEqual(setResult, { success: true });
  return controller.startPairing(target ? { target } : {});
}

test("startPairing 生成 roomId/capability 二维码载荷,room.ready 推送 waiting", async () => {
  const { controller, tunnels, broadcasts } = makeController();
  const result = await enableAndStart(controller, MIRROR_TARGET);
  assert.equal(result.success, true);
  if (!result.success) return;
  // 契约 §5:URL = https://<域名>/p/<roomId>#c=<capability>,capability 只在 fragment。
  assert.ok(result.pairingUrl.startsWith("https://tunnel.example.com/p/"));
  const fragment = result.pairingUrl.split("#")[1] ?? "";
  assert.ok(fragment.startsWith("c="));
  const capabilityFromUrl = decodeURIComponent(fragment.slice(2));
  // capHash = SHA-256(capability) 的 base64url(§4.1),由 room.create 上送。
  const { createHash } = await import("node:crypto");
  assert.equal(
    tunnels[0]!.params.capHash,
    createHash("sha256").update(capabilityFromUrl).digest("base64url"),
  );
  assert.equal(tunnels[0]!.params.roomId, result.roomId);

  tunnels[0]!.delegate.onRoomReady({
    type: "room.ready",
    proto: 1,
    roomId: result.roomId,
    expiresAt: 42,
  });
  const states = broadcasts.map((entry) => entry.payload);
  assert.ok(states.some((state) => state.state === "waiting" && state.roomId === result.roomId));
});

test("全新安装默认使用托管 Worker，空 Key 可启动且每个房间生成独立 host token", async () => {
  const { controller, tunnels } = makeController();
  const initial = await controller.getConfig();
  assert.equal(initial.workerBaseUrl, DEFAULT_REMOTE_CONTROL_WORKER_BASE_URL);
  assert.equal(initial.hasAccessKey, false);
  assert.deepEqual(await controller.setConfig({ workerBaseUrl: "" }), { success: true });
  assert.equal(
    (await controller.getConfig()).workerBaseUrl,
    DEFAULT_REMOTE_CONTROL_WORKER_BASE_URL,
  );

  assert.deepEqual(await controller.setConfig({ enabled: true }), { success: true });
  const first = await controller.startPairing({ target: MIRROR_TARGET });
  assert.ok(first.success);
  assert.equal(tunnels[0]!.params.accessKey, undefined);
  assert.match(tunnels[0]!.params.clientId, /^[A-Za-z0-9_-]{43}$/);
  assert.match(tunnels[0]!.params.hostToken, /^[A-Za-z0-9_-]{43}$/);

  const firstHostToken = tunnels[0]!.params.hostToken;
  const second = await controller.startPairing({ target: MIRROR_TARGET });
  assert.ok(second.success);
  assert.notEqual(tunnels[1]!.params.hostToken, firstHostToken);
  assert.equal(tunnels[1]!.params.clientId, tunnels[0]!.params.clientId);
});

test("多窗口并发开启时仅最后一次请求创建房间，不遗留孤儿隧道", async () => {
  const { controller, tunnels } = makeController();
  assert.deepEqual(await controller.setConfig({ enabled: true }), { success: true });

  const [first, second] = await Promise.all([
    controller.startPairing({ target: MIRROR_TARGET }),
    controller.startPairing({ target: MIRROR_TARGET }),
  ]);
  assert.deepEqual(first, { success: false, error: "PAIRING_REQUEST_SUPERSEDED" });
  assert.equal(second.success, true);
  assert.equal(tunnels.length, 1);
});

test("allowNewDevices=false 时 pairing.requested 未等用户裁决即被自动拒绝", async () => {
  const { controller, tunnels, broadcasts } = makeController();
  await controller.setConfig({
    enabled: true,
    workerBaseUrl: "https://tunnel.example.com",
    accessKey: "ak-valid-key-123456789012345678901234567890",
    allowNewDevices: false,
  });
  const start = await controller.startPairing({ target: MIRROR_TARGET });
  assert.ok(start.success);
  const tunnel = tunnels[0]!;
  tunnel.delegate.onPairingRequested({
    type: "pairing.requested",
    proto: 1,
    requestId: "req-x",
    roomId: tunnel.params.roomId,
    deviceName: "Phone",
    ua: "UA",
  });
  assert.deepEqual(tunnel.decided, [{ requestId: "req-x", accept: false }]);

  // 自动拒绝不能静默:推送 error 让面板感知本次拒绝,并立即重建房间回可扫码状态。
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(tunnels[0]!.stopped, true); // 旧房间已因重建被 stop
  assert.equal(tunnels.length, 2); // 新房间已生成(新 roomId/新二维码)
  const states = broadcasts.map((entry) => entry.payload);
  assert.ok(
    states.some((state) => state.state === "error" && state.error === "NEW_DEVICE_REJECTED"),
  );
  // 新房间完成 room.ready 注册后面板回到 waiting(新二维码可扫)。
  tunnels[1]!.delegate.onRoomReady({
    type: "room.ready",
    proto: 1,
    roomId: tunnels[1]!.params.roomId,
    expiresAt: 789,
  });
  assert.ok(
    broadcasts
      .map((entry) => entry.payload)
      .some((state) => state.state === "waiting" && state.roomId === tunnels[1]!.params.roomId),
  );
});

test("bridged 状态下 host socket 重连的 room.ready 不把面板推回 waiting(§3.3)", async () => {
  const { controller, tunnels, broadcasts } = makeController();
  const start = await enableAndStart(controller, MIRROR_TARGET);
  assert.ok(start.success);
  const tunnel = tunnels[0]!;
  tunnel.delegate.onBridgeOpen({
    type: "bridge.open",
    proto: 1,
    deviceId: "device-1",
    resumed: false,
  });
  const bridgedIndex = broadcasts.map((entry) => entry.payload.state).lastIndexOf("bridged");
  assert.ok(bridgedIndex >= 0);

  // host socket 闪断重连成功,DO 保留桥并忽略重发的 room.create:重发的 room.ready
  // 不得把面板推回 waiting(旧二维码已消费)。
  tunnel.delegate.onRoomReady({
    type: "room.ready",
    proto: 1,
    roomId: tunnel.params.roomId,
    expiresAt: 456,
  });
  const statesAfter = broadcasts.slice(bridgedIndex).map((entry) => entry.payload.state);
  assert.deepEqual(statesAfter, ["bridged"]);
});

test("主开关关闭/缺接入 Key/域名非法时不出站(start 返回 fail-closed 错误)", async () => {
  const { controller, tunnels, map } = makeController();
  const disabled = await controller.startPairing({});
  assert.deepEqual(disabled, { success: false, error: "REMOTE_CONTROL_DISABLED" });

  await controller.setConfig({ enabled: true, workerBaseUrl: "https://tunnel.example.com" });
  const missingKey = await controller.startPairing({});
  assert.deepEqual(missingKey, { success: false, error: "ACCESS_KEY_MISSING" });

  map.set(REMOTE_CONTROL_ACCESS_KEY_CREDENTIAL_KEY, "ak-valid-key-123456789012345678901234567890");
  await controller.setConfig({ workerBaseUrl: "ftp://bad.example.com" });
  // setConfig 对非法域名直接拒绝。
  const badConfig = await controller.setConfig({ workerBaseUrl: "http://public.example.com" });
  assert.equal(badConfig.success, false);
  assert.equal(tunnels.length, 0);
});

test("pairing.requested → 用户 accept → 设备凭据哈希持久化;吊销即时生效", async () => {
  const { controller, tunnels, broadcasts, map } = makeController();
  const start = await enableAndStart(controller, MIRROR_TARGET);
  assert.ok(start.success);
  const tunnel = tunnels[0]!;

  tunnel.delegate.onPairingRequested({
    type: "pairing.requested",
    proto: 1,
    requestId: "req-1",
    roomId: tunnel.params.roomId,
    deviceName: "Phone",
    ua: "Mozilla/5.0",
  });
  const pairingStates = broadcasts
    .map((entry) => entry.payload)
    .filter((state) => state.state === "pairing");
  assert.equal(pairingStates.length, 1);
  assert.deepEqual(pairingStates[0]!.pendingDevice, {
    requestId: "req-1",
    deviceName: "Phone",
    ua: "Mozilla/5.0",
  });

  await controller.decidePairing({ requestId: "req-1", accept: true });
  assert.deepEqual(tunnel.decided, [{ requestId: "req-1", accept: true }]);

  tunnel.delegate.onPairingAccepted({
    type: "pairing.accepted",
    requestId: "req-1",
    roomId: tunnel.params.roomId,
    deviceId: "device-1",
    deviceName: "Phone",
    credHash: "credhash-1",
    grantedAt: 111,
  });
  // 持久化是异步 fire-and-forget;等待一个微任务排空。
  await new Promise((resolve) => setTimeout(resolve, 0));
  const persisted = JSON.parse(
    map.get(REMOTE_CONTROL_DEVICES_CREDENTIAL_KEY) ?? "[]",
  ) as RemoteControlPersistedDevice[];
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0]!.deviceId, "device-1");
  assert.equal(persisted[0]!.credHash, "credhash-1");

  const devices = await controller.refreshDevices();
  assert.deepEqual(devices.devices, [
    { deviceId: "device-1", deviceName: "Phone", grantedAt: 111, lastSeenAt: 111 },
  ]);
  await controller.revokeDevice("device-1");
  assert.deepEqual(tunnel.revoked, ["device-1"]);
  const afterRevoke = await controller.refreshDevices();
  assert.equal(afterRevoke.devices.length, 0);
});

test("bridge.open:attach 以 web-remote-replayable 调度,帧泵双向连通", async () => {
  const { controller, tunnels, broadcasts, okAttach } = makeController();
  const start = await enableAndStart(controller, MIRROR_TARGET);
  assert.ok(start.success);
  const tunnel = tunnels[0]!;

  tunnel.delegate.onBridgeOpen({
    type: "bridge.open",
    proto: 1,
    deviceId: "device-1",
    resumed: false,
  });
  assert.equal(okAttach.calls.length, 1);
  assert.deepEqual(okAttach.calls[0], {
    windowId: 1,
    remoteSessionId: "rs-1",
    workspacePath: "/work",
    workspaceIdentity: "wi-1",
    workspaceKey: "wi-1",
    clientMode: "web-remote-replayable",
  });
  assert.ok(broadcasts.some((entry) => entry.payload.state === "bridged"));

  // WS→port:合法 Regular 帧剥头后送达 port。
  tunnel.delegate.onBridgeBinary?.(encodeRemoteControlRegularFrame(new Uint8Array([5, 6])));
  assert.equal(okAttach.postedToPort.length, 1);
  assert.deepEqual([...okAttach.postedToPort[0]!], [5, 6]);

  // port→WS:Uint8Array 包成 Regular 帧写回隧道。
  okAttach.emitPortMessage(new Uint8Array([7]));
  assert.equal(tunnel.sentBinary.length, 1);
  assert.equal(tunnel.sentBinary[0]![0], 1);

  // port 流控对象不穿越 WS。
  okAttach.emitPortMessage({ __lcodeRpcControl: "connection-flow-v1", state: "saturated" });
  assert.equal(tunnel.sentBinary.length, 1);
});

test('本地工作区镜像:local target 走 scope:{kind:"local"} 第二 attachment', async () => {
  const { controller, tunnels, broadcasts, okAttach } = makeController();
  const start = await enableAndStart(controller, {
    kind: "local",
    windowId: 1,
    workspacePath: "/work/local-demo",
    workspaceIdentity: "/work/local-demo",
  } as unknown as typeof MIRROR_TARGET);
  assert.ok(start.success);
  const tunnel = tunnels[0]!;

  tunnel.delegate.onBridgeOpen({
    type: "bridge.open",
    proto: 1,
    deviceId: "device-local",
    resumed: false,
  });
  // local 分支不经 remote 入口:不携带三元组/workspaceKey,只传窗口(Main 权威覆盖后)。
  assert.equal(okAttach.calls.length, 1);
  assert.deepEqual(okAttach.calls[0], { windowId: 1 });
  assert.ok(broadcasts.some((entry) => entry.payload.state === "bridged"));
  // 本地镜像与 remote 一样有完整数据面:WS↔port 帧双向。
  tunnel.delegate.onBridgeBinary?.(encodeRemoteControlRegularFrame(new Uint8Array([9])));
  assert.equal(okAttach.postedToPort.length, 1);
  okAttach.emitPortMessage(new Uint8Array([8]));
  assert.equal(tunnel.sentBinary.length, 1);
});

test("resumed 重连复用既有桥:不重复 attach、不 detach、帧仍双向(§3.3)", async () => {
  const { controller, tunnels, broadcasts, okAttach } = makeController();
  const start = await enableAndStart(controller, MIRROR_TARGET);
  assert.ok(start.success);
  const tunnel = tunnels[0]!;
  tunnel.delegate.onBridgeOpen({
    type: "bridge.open",
    proto: 1,
    deviceId: "device-1",
    resumed: false,
  });
  assert.equal(okAttach.calls.length, 1);

  // 手机断网(60s 宽限内不 detach)后凭设备凭据重连,worker 再次 bridge.open{resumed:true}。
  tunnel.delegate.onPeerDisconnected({
    type: "peer.disconnected",
    deviceId: "device-1",
    side: "client",
  });
  tunnel.delegate.onBridgeOpen({
    type: "bridge.open",
    proto: 1,
    deviceId: "device-1",
    resumed: true,
  });
  // 复用既有 attachment/pump:attach 仍只调过一次,旧 attachmentId 没有收到任何 detach。
  assert.equal(okAttach.calls.length, 1);
  assert.equal(
    okAttach.detachMessages.filter((message) => message.type === "detach-service-port").length,
    0,
  );
  // resumed 重连复用 attachment 不重建 ChannelServer,必须请求 host 重发 RPC Initialize:
  // 手机页面 reload 后是全新 ChannelClient,缺失该帧所有请求永久排队,镜像永远不渲染。
  assert.deepEqual(
    okAttach.detachMessages.filter((message) => message.type === "resend-service-port-init"),
    [{ type: "resend-service-port-init", attachmentId: "attachment-1" }],
  );
  // 帧泵仍指向同一条隧道,双向转发继续可用(不存在第二条写入路径)。
  tunnel.delegate.onBridgeBinary?.(encodeRemoteControlRegularFrame(new Uint8Array([9])));
  assert.equal(okAttach.postedToPort.length, 1);
  assert.deepEqual([...okAttach.postedToPort[0]!], [9]);
  okAttach.emitPortMessage(new Uint8Array([1]));
  assert.equal(tunnel.sentBinary.length, 1);
  const bridgedCount = broadcasts.filter((entry) => entry.payload.state === "bridged").length;
  assert.equal(bridgedCount, 2);
});

test("不同设备在已有桥时再桥接:fail-closed 停房并报 ROOM_BUSY", async () => {
  const { controller, tunnels, broadcasts, okAttach } = makeController();
  const start = await enableAndStart(controller, MIRROR_TARGET);
  assert.ok(start.success);
  const tunnel = tunnels[0]!;
  tunnel.delegate.onBridgeOpen({
    type: "bridge.open",
    proto: 1,
    deviceId: "device-1",
    resumed: false,
  });
  tunnel.delegate.onBridgeOpen({
    type: "bridge.open",
    proto: 1,
    deviceId: "device-2",
    resumed: false,
  });
  // v1 每房间最多 1 条桥(§3.2 4008):不允许静默叠加第二个 attachment/写入路径。
  assert.equal(okAttach.calls.length, 1);
  assert.equal(tunnel.stopped, true);
  assert.ok(
    broadcasts.some(
      (entry) => entry.payload.state === "error" && entry.payload.error === "ROOM_BUSY",
    ),
  );
});

test("attach fail-closed code 原样映射到 UI 并停止房间", async () => {
  const failingAttach = () => {
    throw Object.assign(new Error("未找到远程 workspace session"), {
      code: "REMOTE_SESSION_MISSING",
    });
  };
  const { controller, tunnels, broadcasts } = makeController({ attach: failingAttach });
  const start = await enableAndStart(controller, MIRROR_TARGET);
  assert.ok(start.success);
  tunnels[0]!.delegate.onBridgeOpen({
    type: "bridge.open",
    proto: 1,
    deviceId: "device-1",
    resumed: false,
  });
  assert.ok(
    broadcasts.some(
      (entry) =>
        entry.payload.state === "error" && entry.payload.error === "REMOTE_SESSION_MISSING",
    ),
  );
  assert.equal(tunnels[0]!.stopped, true);
});

test("无镜像目标时桥 fail-closed 关闭(MIRROR_TARGET_MISSING)", async () => {
  const { controller, tunnels, broadcasts } = makeController();
  const start = await enableAndStart(controller);
  assert.ok(start.success);
  tunnels[0]!.delegate.onBridgeOpen({
    type: "bridge.open",
    proto: 1,
    deviceId: "device-1",
    resumed: false,
  });
  assert.ok(
    broadcasts.some(
      (entry) => entry.payload.state === "error" && entry.payload.error === "MIRROR_TARGET_MISSING",
    ),
  );
  assert.equal(tunnels[0]!.stopped, true);
});

test("bridge.detached:先停泵再 detach-service-port,房间存活、面板报 error 不报 stopped", async () => {
  const { controller, tunnels, broadcasts, okAttach } = makeController();
  const start = await enableAndStart(controller, MIRROR_TARGET);
  assert.ok(start.success);
  const tunnel = tunnels[0]!;
  tunnel.delegate.onBridgeOpen({
    type: "bridge.open",
    proto: 1,
    deviceId: "device-1",
    resumed: false,
  });

  tunnel.delegate.onBridgeDetached({ type: "bridge.detached", deviceId: "device-1" });
  const detach = okAttach.detachMessages.find((message) => message.type === "detach-service-port");
  assert.ok(detach);
  assert.equal(detach.attachmentId, okAttach.attachmentId);

  // 停泵后 WS 帧不再转发到 port(顺序不可倒置的可见结果)。
  tunnel.delegate.onBridgeBinary?.(encodeRemoteControlRegularFrame(new Uint8Array([1])));
  assert.equal(okAttach.postedToPort.length, 0);

  // 房间并未终止(手机可凭设备凭据重连再次 bridged):面板推送 error 而非 stopped。
  const lastPush = broadcasts[broadcasts.length - 1]!.payload;
  assert.equal(lastPush.state, "error");
  assert.equal(lastPush.error, "BRIDGE_DETACHED");
  assert.equal(tunnel.stopped, false);
});

test("桥结束后重新布防空闲自动断开;桥接期间不触发(§3.4)", { timeout: 4_000 }, async () => {
  const { controller, tunnels } = makeController();
  const setResult = await controller.setConfig({
    enabled: true,
    workerBaseUrl: "https://tunnel.example.com",
    accessKey: "ak-valid-key-123456789012345678901234567890",
    idleDisconnectMs: 60,
  });
  assert.deepEqual(setResult, { success: true });
  const start = await controller.startPairing({ target: MIRROR_TARGET });
  assert.ok(start.success);
  const tunnel = tunnels[0]!;
  tunnel.delegate.onBridgeOpen({
    type: "bridge.open",
    proto: 1,
    deviceId: "device-1",
    resumed: false,
  });

  // 桥接建立即清除空闲定时器:桥接期间不得被切断。
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(tunnel.stopped, false);

  // 桥结束(teardown)后按 activeIdleDisconnectMs 重新布防:超时未再桥接即 room.stop。
  tunnel.delegate.onBridgeDetached({ type: "bridge.detached", deviceId: "device-1" });
  await new Promise((resolve) => setTimeout(resolve, 160));
  assert.equal(tunnel.stopped, true);
});

test("stopPairing/dispose:stopRoom 幂等生效并推送 stopped", async () => {
  const { controller, tunnels, broadcasts } = makeController();
  const start = await enableAndStart(controller, MIRROR_TARGET);
  assert.ok(start.success);
  await controller.stopPairing("test");
  assert.equal(tunnels[0]!.stopped, true);
  assert.ok(broadcasts.some((entry) => entry.payload.state === "stopped"));

  // 重复 stop 幂等。
  await controller.stopPairing("test-again");
  assert.equal(tunnels.length, 1);

  // dispose 后 start 拒绝。
  controller.dispose("quit");
  const afterDispose = await controller.startPairing({ target: MIRROR_TARGET });
  assert.deepEqual(afterDispose, { success: false, error: "REMOTE_CONTROL_DISPOSED" });
});

test("setConfig(enabled:false) 立即停止会话;getConfig 只回 hasAccessKey", async () => {
  const { controller, tunnels, map } = makeController();
  const start = await enableAndStart(controller, MIRROR_TARGET);
  assert.ok(start.success);
  assert.equal(map.has(REMOTE_CONTROL_ACCESS_KEY_CREDENTIAL_KEY), true);

  const config = await controller.getConfig();
  assert.deepEqual(config, {
    enabled: true,
    workerBaseUrl: "https://tunnel.example.com",
    hasAccessKey: true,
    pairingTtlMs: 300_000,
    allowNewDevices: true,
    idleDisconnectMs: 0,
  });

  await controller.setConfig({ enabled: false });
  assert.equal(tunnels[0]!.stopped, true);
  const after = await controller.getConfig();
  assert.equal(after.enabled, false);
  assert.equal(after.hasAccessKey, true);
});
