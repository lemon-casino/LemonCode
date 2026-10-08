/* 出站隧道连接器:Desktop Main ↔ CF Worker `WS /connect/host`。
 * 契约:cfworker-remote/PROTOCOL.md §1.1(升级 header/query)、§1.2(首帧 proto:1)、
 * §2(控制帧/桥接)、§3.3(host socket 断开 30s 宽限重连)、§3.4(30s 心跳)、§3.2(close code)。
 * 本模块只维护传输与控制帧;配对裁决/attachment 调度/持久化都在 controller。 */
/* eslint-disable max-lines -- 房间/配对/心跳/重连共用同一条 socket 的生命周期闭包,集中维护避免事件时序拆散。 */
import WebSocket from "ws";
import {
  remoteControlHostSocketFrameSchema,
  remoteControlPairingAcceptFrameSchema,
  remoteControlPairingRejectFrameSchema,
  remoteControlRoomCreateFrameSchema,
  remoteControlRoomStopFrameSchema,
  remoteControlDeviceRevokeFrameSchema,
  remoteControlPingFrameSchema,
  encodeRemoteControlBridgeFrame,
  decodeRemoteControlBridgeFrame,
  remoteControlPairingRefreshFrameSchema,
  remoteControlBridgeCloseFrameSchema,
  type RemoteControlPairingCancelledFrame,
  type RemoteControlBridgeDetachedFrame,
  type RemoteControlBridgeOpenFrame,
  type RemoteControlErrorFrame,
  type RemoteControlPairingAcceptedFrame,
  type RemoteControlPairingRequestedFrame,
  type RemoteControlPeerDisconnectedFrame,
  type RemoteControlRoomExpiredFrame,
  type RemoteControlRoomInvalidatedFrame,
  type RemoteControlRoomReadyFrame,
} from "@lcode/shared";

export const REMOTE_CONTROL_HEARTBEAT_INTERVAL_MS = 30_000;
/** host socket 断开后的重连宽限:与 DO 的 30s 保留期一致(PROTOCOL.md §3.3,v1 常量不配置)。 */
export const REMOTE_CONTROL_HOST_RECONNECT_GRACE_MS = 30_000;
export const REMOTE_CONTROL_RECONNECT_RETRY_DELAY_MS = 2_000;
/** bridge.open 之前 host socket BINARY 帧的违规断开阈值(对齐 §6.4 "计数+断开")。 */
export const REMOTE_CONTROL_PRE_BRIDGE_BINARY_LIMIT = 5;
/** 心跳超时 close code;命中即终态,不再重连(PROTOCOL.md §3.2)。 */
const CLOSE_HEARTBEAT_TIMEOUT = 4001;
const CLOSE_AUTH_FAILED = 4002;
const CLOSE_PROTOCOL_VIOLATION = 4003;
const CLOSE_ROOM_MISSING = 4004;
const CLOSE_ROOM_EXPIRED = 4005;
const CLOSE_ROOM_INVALIDATED = 4006;
const CLOSE_ROOM_STOPPED = 4007;
const CLOSE_ROOM_BUSY = 4008;

export interface RemoteControlTunnelLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface RemoteControlTunnelDelegate {
  onRoomReady(frame: RemoteControlRoomReadyFrame): void;
  onPairingRequested(frame: RemoteControlPairingRequestedFrame): void;
  onPairingAccepted(frame: RemoteControlPairingAcceptedFrame): void;
  onPairingCancelled?(frame: RemoteControlPairingCancelledFrame): void;
  onBridgeOpen(frame: RemoteControlBridgeOpenFrame): void;
  onBridgeDetached(frame: RemoteControlBridgeDetachedFrame): void;
  onPeerDisconnected(frame: RemoteControlPeerDisconnectedFrame): void;
  onRoomInvalidated(frame: RemoteControlRoomInvalidatedFrame): void;
  onRoomExpired(frame: RemoteControlRoomExpiredFrame): void;
  onProtocolError(frame: RemoteControlErrorFrame): void;
  /** 升级被 401 拒绝:接入 Key 错误;不重连(房间尚未注册,401 不计失败计数,§1.1)。 */
  onAuthRejected(): void;
  /** host socket 意外断开;宽限期内 tunnel 自动重连,期间桥静默(§3.3)。 */
  onTransportSuspended(info: { code: number; reason: string; graceDeadlineAt: number }): void;
  /** 终态关闭:不再重连,tunnel 已耗尽。 */
  onClosed(info: { code: number; reason: string }): void;
  /** 桥接阶段 host socket 上的 BINARY 帧(Worker 透传的手机 SocketProtocol 帧)。 */
  onBridgeBinary?(data: Uint8Array, deviceId?: string): void;
}

export interface RemoteControlTunnelStartParams {
  /** 已由 normalizeRemoteControlWorkerBaseUrl 规范化的 origin。 */
  workerBaseUrl: string;
  /** 自建 Worker 的部署接入 Key；官方托管服务必须为空，避免分发共享秘密。 */
  accessKey?: string;
  /** 匿名托管服务限速使用的稳定安装 ID，不是认证秘密。 */
  clientId: string;
  /** 每房间独立的 host 重连凭据；不进二维码、Renderer 或持久化配置。 */
  hostToken: string;
  roomId: string;
  capHash: string;
  ttlMs: number;
  multiDevice?: true;
  devices: Array<{ deviceId: string; credHash: string; deviceName: string }>;
}

/** 测试注入用最小 socket 面;生产实现见 createWsTunnelSocket。 */
export interface RemoteControlTunnelSocket {
  sendText(data: string): void;
  sendBinary(data: Uint8Array): void;
  close(code: number, reason: string): void;
  onOpen(listener: () => void): void;
  onText(listener: (data: string) => void): void;
  onBinary(listener: (data: Uint8Array) => void): void;
  onClose(listener: (code: number, reason: string) => void): void;
  onError(listener: (error: Error) => void): void;
  /** 升级被 HTTP 状态码拒绝(接入 Key 错误 → 401)。 */
  onUpgradeRejected(listener: (statusCode: number) => void): void;
  /** 反压执行点(帧泵 port 流控暂停/恢复底层 WS 读)。 */
  setReadPaused?(paused: boolean): void;
}

export interface RemoteControlTunnelSession {
  readonly roomId: string;
  /** 对 pairing.requested 的裁决;同一 requestId 只生效一次(§2.2)。 */
  decide(requestId: string, accept: boolean, rejectReason?: string): void;
  revokeDevice(deviceId: string): void;
  refreshPairing(capHash: string, ttlMs: number): void;
  closeBridge(deviceId: string, code?: number): void;
  /** 发 room.stop 并正常关闭;立即断开现有连接且不再重连(验收:停止语义)。 */
  stopRoom(): void;
  /** 帧泵违规断开等场景:关闭 socket、不重连、不发 room.stop。 */
  close(code: number, reason: string): void;
  /** 帧泵 Host→手机方向(仅 bridged 后调用)。 */
  sendBridgeBinary(data: Uint8Array, deviceId?: string): void;
  setTransportPaused(paused: boolean): void;
  isBridged(deviceId?: string): boolean;
  isRunning(): boolean;
  /** 退出清理:停心跳/定时器并关闭,不发 room.stop(退出时尽力即可)。 */
  dispose(): void;
}

export interface RemoteControlTunnelOptions {
  heartbeatIntervalMs?: number;
  reconnectGraceMs?: number;
  reconnectRetryDelayMs?: number;
  createSocket?: (url: string, headers: Record<string, string>) => RemoteControlTunnelSocket;
  setTimeoutImpl?: (callback: () => void, ms: number) => NodeJS.Timeout;
  clearTimeoutImpl?: (timer: NodeJS.Timeout) => void;
  nowImpl?: () => number;
}

function defaultCreateSocket(
  url: string,
  headers: Record<string, string>,
): RemoteControlTunnelSocket {
  const socket = new WebSocket(url, { headers });
  const openListeners: Array<() => void> = [];
  const textListeners: Array<(data: string) => void> = [];
  const binaryListeners: Array<(data: Uint8Array) => void> = [];
  const closeListeners: Array<(code: number, reason: string) => void> = [];
  const errorListeners: Array<(error: Error) => void> = [];
  const upgradeRejectedListeners: Array<(statusCode: number) => void> = [];
  socket.on("open", () => openListeners.forEach((listener) => listener()));
  socket.on("message", (data, isBinary) => {
    if (isBinary) {
      const payload = new Uint8Array(data as Buffer);
      binaryListeners.forEach((listener) => listener(payload));
      return;
    }
    textListeners.forEach((listener) => listener((data as Buffer).toString("utf8")));
  });
  socket.on("close", (code, reason) =>
    closeListeners.forEach((listener) => listener(code, reason.toString("utf8"))),
  );
  socket.on("error", (error) =>
    errorListeners.forEach((listener) =>
      listener(error instanceof Error ? error : new Error(String(error))),
    ),
  );
  socket.on("unexpected-response", (_req, res) =>
    upgradeRejectedListeners.forEach((listener) => listener(res.statusCode ?? 0)),
  );
  return {
    sendText: (data) => socket.send(data),
    sendBinary: (data) => socket.send(data, { binary: true }),
    close: (code, reason) => socket.close(code, reason),
    onOpen: (listener) => openListeners.push(listener),
    onText: (listener) => textListeners.push(listener),
    onBinary: (listener) => binaryListeners.push(listener),
    onClose: (listener) => closeListeners.push(listener),
    onError: (listener) => errorListeners.push(listener),
    onUpgradeRejected: (listener) => upgradeRejectedListeners.push(listener),
    setReadPaused: (paused) => {
      // ws 没有公开 pause API;反压直接作用于底层 TCP socket,避免帧泵缓存业务帧。
      const tcp = (socket as unknown as { _socket?: import("node:net").Socket })._socket;
      if (!tcp) return;
      if (paused) tcp.pause();
      else tcp.resume();
    },
  };
}

export function createRemoteControlTunnelSession(
  params: RemoteControlTunnelStartParams,
  delegate: RemoteControlTunnelDelegate,
  options: RemoteControlTunnelOptions = {},
): RemoteControlTunnelSession {
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? REMOTE_CONTROL_HEARTBEAT_INTERVAL_MS;
  const reconnectGraceMs = options.reconnectGraceMs ?? REMOTE_CONTROL_HOST_RECONNECT_GRACE_MS;
  const reconnectRetryDelayMs =
    options.reconnectRetryDelayMs ?? REMOTE_CONTROL_RECONNECT_RETRY_DELAY_MS;
  const setTimeoutImpl = options.setTimeoutImpl ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimeoutImpl = options.clearTimeoutImpl ?? ((timer) => clearTimeout(timer));
  const nowImpl = options.nowImpl ?? (() => Date.now());
  const createSocket =
    options.createSocket ?? ((url, headers) => defaultCreateSocket(url, headers));

  const upgradeUrl = `${params.workerBaseUrl}/connect/host?roomId=${encodeURIComponent(params.roomId)}`;
  const upgradeHeaders: Record<string, string> = {
    "x-lcode-client-id": params.clientId,
    "x-lcode-host-token": params.hostToken,
  };
  if (params.accessKey) {
    upgradeHeaders["x-lcode-remote-access-key"] = params.accessKey;
  }
  /**
   * 房间设备表的可变快照:吊销即移除,重连重发的 room.create 不再携带被吊销设备的
   * credHash——否则 host socket 断开窗口内丢失的 device.revoke 会让 Worker 侧凭据
   * 哈希在重连后"复活"(违反 §4.3.3 一条 WS RTT 内生效)。
   */
  let liveCapHash = params.capHash;
  let liveTtlMs = params.ttlMs;
  let multiDevice = false;
  const bridgeDevices = new Set<string>();
  const liveDevices = params.devices.map((device) => ({ ...device }));
  function buildRoomCreateFrame(): Record<string, unknown> {
    return remoteControlRoomCreateFrameSchema.parse({
      type: "room.create",
      proto: 1,
      roomId: params.roomId,
      capHash: liveCapHash,
      ttlMs: liveTtlMs,
      ...(params.multiDevice ? { multiDevice: true } : {}),
      devices: liveDevices,
    });
  }

  let socket: RemoteControlTunnelSocket | null = null;
  let socketGeneration = 0;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let reconnectDeadlineAt = 0;
  let running = true;
  let stopRequested = false;
  let bridged = false;
  /** room.create 已在本条 socket 上发出;重连后重发(幂等,§3.3)。 */
  let registered = false;
  /**
   * 宽限重连窗口内积累的高优控制帧(用户裁决/吊销);重连成功后补发,终态时清空。
   * 这些帧表达用户意图,不允许被静默丢弃。
   */
  const pendingControlFrames: string[] = [];
  const decidedRequestIds = new Set<string>();
  /** 跨重连保持的反压状态:新 socket 建立后按它恢复暂停,避免反压边沿丢失。 */
  let transportPaused = false;
  /** bridge.open 之前 host socket 上的 BINARY 帧计数(§6.4 违规语义:计数+断开 4003)。 */
  let preBridgeBinaryViolations = 0;

  openSocket();

  function clearHeartbeat(): void {
    if (!heartbeatTimer) return;
    clearTimeoutImpl(heartbeatTimer);
    heartbeatTimer = null;
  }

  function clearReconnectTimer(): void {
    if (!reconnectTimer) return;
    clearTimeoutImpl(reconnectTimer);
    reconnectTimer = null;
  }

  function sendControlFrame(frame: Record<string, unknown>): void {
    if (!socket || !running || stopRequested) return;
    try {
      socket.sendText(JSON.stringify(frame));
    } catch (error) {
      // 发送失败交由 close/error 路径收口;这里不吞异常状态,只避免控制帧异常打断 Main。
      delegate.onProtocolError({
        type: "error",
        code: "tunnel-send-failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * 用户裁决/吊销帧不允许被静默丢弃:宽限重连窗口内 socket 为空时入队,重连成功
   * (room.create 之后)按序补发。同一 requestId 的 accept/reject 在 Worker 侧只生效
   * 一次(§2.2);device.revoke 对已从设备表移除的 deviceId 是幂等删除(§4.3.3)。
   */
  function sendOrQueueControlFrame(frame: Record<string, unknown>): void {
    if (socket && running && !stopRequested) {
      try {
        socket.sendText(JSON.stringify(frame));
        return;
      } catch {
        // 落入补发队列,由下一次重连成功后的 flush 兜底。
      }
    }
    pendingControlFrames.push(JSON.stringify(frame));
  }

  function flushPendingControlFrames(): void {
    const queued = pendingControlFrames.splice(0, pendingControlFrames.length);
    for (const raw of queued) {
      try {
        socket?.sendText(raw);
      } catch {
        // 仍失败则放弃该条;后续 close 事件会重新走重连/终态路径。
      }
    }
  }

  function clearPendingControlFrames(): void {
    pendingControlFrames.length = 0;
  }

  function startHeartbeat(): void {
    clearHeartbeat();
    heartbeatTimer = setTimeoutImpl(() => {
      heartbeatTimer = null;
      // ≥2 个周期无 ping 才会被 Worker 关闭(§3.4);桌面侧每 30s 一条 TEXT ping。
      sendControlFrame(remoteControlPingFrameSchema.parse({ type: "ping" }));
      startHeartbeat();
    }, heartbeatIntervalMs);
    heartbeatTimer.unref?.();
  }

  function handleTextFrame(raw: string): void {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      // TEXT 必须是单条 JSON 控制帧(§2.1);违规按 4003 收口。
      close(CLOSE_PROTOCOL_VIOLATION, "invalid control frame");
      return;
    }
    const parsed = remoteControlHostSocketFrameSchema.safeParse(parsedJson);
    if (!parsed.success) {
      close(CLOSE_PROTOCOL_VIOLATION, "unknown control frame");
      return;
    }
    const frame = parsed.data;
    switch (frame.type) {
      case "room.ready":
        multiDevice = params.multiDevice === true && frame.multiDevice === true;
        registered = true;
        // room.ready 即重连成功:重置宽限截止,让下一次断开重新获得完整 30s 宽限(§3.3)。
        reconnectDeadlineAt = 0;
        delegate.onRoomReady(frame);
        break;
      case "pairing.requested":
        delegate.onPairingRequested(frame);
        break;
      case "pairing.accepted":
        // 会话中途新配对的设备会进入 Worker 本房间的凭据表;同步进本地设备表,
        // 重连重发的 room.create 才不会把刚配对设备的哈希刷掉。
        if (!liveDevices.some((device) => device.deviceId === frame.deviceId)) {
          if (liveDevices.length >= 64) {
            // 新授权不能让重连 room.create 超出上限，也不能挤掉仍有活桥的凭据。
            const index = liveDevices.findLastIndex(
              (device) => !bridgeDevices.has(device.deviceId),
            );
            if (index >= 0) liveDevices.splice(index, 1);
          }
          liveDevices.push({
            deviceId: frame.deviceId,
            credHash: frame.credHash,
            deviceName: frame.deviceName,
          });
        }
        delegate.onPairingAccepted(frame);
        break;
      case "pairing.cancelled":
        delegate.onPairingCancelled?.(frame);
        break;
      case "bridge.open":
        bridgeDevices.add(frame.deviceId);
        bridged = true;
        delegate.onBridgeOpen(frame);
        break;
      case "bridge.detached":
        bridgeDevices.delete(frame.deviceId);
        bridged = bridgeDevices.size > 0;
        delegate.onBridgeDetached(frame);
        break;
      case "peer.disconnected":
        // 手机 60s 重连宽限内桌面不 detach(§3.3);仅上报供状态展示。
        delegate.onPeerDisconnected(frame);
        break;
      case "room.invalidated":
        delegate.onRoomInvalidated(frame);
        break;
      case "room.expired":
        delegate.onRoomExpired(frame);
        break;
      case "pong":
        // 心跳回包仅证明链路存活;last-seen 由 Worker 维护。
        break;
      case "error":
        delegate.onProtocolError(frame);
        break;
    }
  }

  function handleBinaryFrame(data: Uint8Array): void {
    if (!bridged) {
      // bridge.open 之前 host socket 上出现 BINARY 属协议违规(§2.3/§6.4):计数并
      // 在达到阈值时以 4003 断开,不做静默吞没,保持对异常 Worker 的可观测性。
      preBridgeBinaryViolations += 1;
      if (preBridgeBinaryViolations >= REMOTE_CONTROL_PRE_BRIDGE_BINARY_LIMIT) {
        close(CLOSE_PROTOCOL_VIOLATION, "binary frame before bridge.open");
        return;
      }
      return;
    }
    if (multiDevice) {
      try {
        const decoded = decodeRemoteControlBridgeFrame(data);
        if (bridgeDevices.has(decoded.deviceId))
          delegate.onBridgeBinary?.(decoded.payload, decoded.deviceId);
      } catch {
        close(CLOSE_PROTOCOL_VIOLATION, "invalid bridge route");
      }
      return;
    }
    delegate.onBridgeBinary?.(data);
  }

  function openSocket(): void {
    if (!running || stopRequested) return;
    const nextSocket = createSocket(upgradeUrl, upgradeHeaders);
    const generation = ++socketGeneration;
    socket = nextSocket;
    nextSocket.onOpen(() => {
      if (socket !== nextSocket || !running || stopRequested) return;
      // 升级后第一个控制帧必须携带 proto:1(§1.2);room.create 即首帧。
      // 每次连接都用当前设备表重建:被吊销设备的 credHash 不随重连复活(§4.3.3)。
      sendControlFrame(buildRoomCreateFrame());
      flushPendingControlFrames();
      // 上一条 socket 暂停读期间断开的,新 socket 恢复同一反压状态,避免边沿丢失。
      if (transportPaused) nextSocket.setReadPaused?.(true);
      startHeartbeat();
    });
    // 重连换代后忽略旧 socket 的迟到事件，不能清心跳或拆当前设备桥。
    nextSocket.onText((data) => {
      if (socket === nextSocket && running && !stopRequested) handleTextFrame(data);
    });
    nextSocket.onBinary((data) => {
      if (socket === nextSocket && running && !stopRequested) handleBinaryFrame(data);
    });
    nextSocket.onClose((code, reason) => {
      // 本地主动 close 已清 socket 引用，但同代数的 close 仍负责终态通知。
      if (generation !== socketGeneration) return;
      clearHeartbeat();
      if (socket === nextSocket) socket = null;
      handleClose(code, reason);
    });
    nextSocket.onError(() => {
      // error 之后必有 close;这里仅记录,避免双路径重复收口。
    });
    nextSocket.onUpgradeRejected((statusCode) => {
      if (socket !== nextSocket) return;
      clearHeartbeat();
      running = false;
      if (socket === nextSocket) socket = null;
      if (statusCode === 401) {
        // 接入 Key 错误:房间尚未注册,不计房间失败计数,也不重连(§1.1)。
        delegate.onAuthRejected();
        delegate.onClosed({ code: statusCode, reason: "access key rejected" });
        return;
      }
      delegate.onClosed({ code: statusCode, reason: "upgrade rejected" });
    });
  }

  function handleClose(code: number, reason: string): void {
    if (!running || stopRequested) {
      if (!running) delegate.onClosed({ code, reason });
      return;
    }
    // 终态 close code:不再重连(§3.2)。
    const permanent =
      code === CLOSE_HEARTBEAT_TIMEOUT ||
      code === CLOSE_AUTH_FAILED ||
      code === CLOSE_PROTOCOL_VIOLATION ||
      code === CLOSE_ROOM_MISSING ||
      code === CLOSE_ROOM_EXPIRED ||
      code === CLOSE_ROOM_INVALIDATED ||
      code === CLOSE_ROOM_STOPPED ||
      code === CLOSE_ROOM_BUSY ||
      code === 1000;
    if (permanent) {
      running = false;
      delegate.onClosed({ code, reason });
      return;
    }
    if (!registered) {
      // 首次注册尚未成功(如 4004/网络拒绝):不进入重连循环,交由上层重新开启等待。
      running = false;
      delegate.onClosed({ code, reason });
      return;
    }
    const now = nowImpl();
    if (!reconnectDeadlineAt) reconnectDeadlineAt = now + reconnectGraceMs;
    if (now >= reconnectDeadlineAt) {
      running = false;
      delegate.onClosed({
        code,
        reason: reason || "host reconnect grace exhausted",
      });
      return;
    }
    delegate.onTransportSuspended({
      code,
      reason,
      graceDeadlineAt: reconnectDeadlineAt,
    });
    reconnectTimer = setTimeoutImpl(() => {
      reconnectTimer = null;
      // 重连计时器到点时复查宽限:避免在宽限尽头仍发起注定失败的尝试(§3.3)。
      if (nowImpl() >= reconnectDeadlineAt) {
        running = false;
        delegate.onClosed({ code: 0, reason: "host reconnect grace exhausted" });
        return;
      }
      openSocket();
    }, reconnectRetryDelayMs);
    reconnectTimer.unref?.();
  }

  function close(code: number, reason: string): void {
    clearHeartbeat();
    clearReconnectTimer();
    try {
      socket?.close(code, reason);
    } catch {
      // socket 已死时 close 抛错属正常路径。
    }
    socket = null;
  }

  return {
    roomId: params.roomId,
    decide(requestId, accept, rejectReason = "rejected by desktop user") {
      if (decidedRequestIds.has(requestId)) return;
      decidedRequestIds.add(requestId);
      if (accept) {
        sendOrQueueControlFrame(
          remoteControlPairingAcceptFrameSchema.parse({
            type: "pairing.accept",
            requestId,
          }),
        );
        return;
      }
      sendOrQueueControlFrame(
        remoteControlPairingRejectFrameSchema.parse({
          type: "pairing.reject",
          requestId,
          reason: rejectReason.slice(0, 256),
        }),
      );
    },
    refreshPairing(capHash, ttlMs) {
      if (!multiDevice) return;
      liveCapHash = capHash;
      liveTtlMs = ttlMs;
      sendOrQueueControlFrame(
        remoteControlPairingRefreshFrameSchema.parse({ type: "pairing.refresh", capHash, ttlMs }),
      );
    },
    closeBridge(deviceId, code = 4003) {
      if (!multiDevice) {
        close(code, "bridge closed");
        return;
      }
      bridgeDevices.delete(deviceId);
      bridged = bridgeDevices.size > 0;
      sendOrQueueControlFrame(
        remoteControlBridgeCloseFrameSchema.parse({
          type: "bridge.close",
          deviceId,
          code: code === 1013 ? 1013 : 4003,
        }),
      );
    },
    revokeDevice(deviceId) {
      // 先从房间设备表移除:重连重发的 room.create 不再携带该设备哈希,吊销不因
      // host socket 断开窗口丢帧而在 Worker 侧复活(§4.3.3)。
      const index = liveDevices.findIndex((device) => device.deviceId === deviceId);
      if (index >= 0) liveDevices.splice(index, 1);
      // 始终发送/入队 device.revoke(对未知 deviceId 是幂等删除,§4.3.3):涵盖会话
      // 中途 pairing.accepted 新登记设备的吊销;宽限窗口内自动入队,重连后随
      // room.create 补发,不存在静默丢帧窗口。
      sendOrQueueControlFrame(
        remoteControlDeviceRevokeFrameSchema.parse({ type: "device.revoke", deviceId }),
      );
    },
    stopRoom() {
      // 先发 room.stop(一条 WS RTT 内生效,§4.3.3)再以 1000 收口;失败也继续关闭。
      try {
        socket?.sendText(
          JSON.stringify(remoteControlRoomStopFrameSchema.parse({ type: "room.stop" })),
        );
      } catch {
        // 发送失败不阻塞停止语义。
      }
      stopRequested = true;
      running = false;
      clearHeartbeat();
      clearReconnectTimer();
      clearPendingControlFrames();
      close(1000, "room stopped by desktop");
    },
    close(code, reason) {
      stopRequested = true;
      running = false;
      clearPendingControlFrames();
      close(code, reason);
    },
    sendBridgeBinary(data, deviceId) {
      // 这里的入参是帧泵已包好头的完整 Regular 帧;帧封装唯一发生在帧泵(§6.4)。
      if (!socket || !bridged) return;
      if (multiDevice) {
        if (!deviceId || !bridgeDevices.has(deviceId)) return;
        socket.sendBinary(encodeRemoteControlBridgeFrame(deviceId, data));
      } else socket.sendBinary(data);
    },
    setTransportPaused(paused) {
      // 记住反压状态:重连的新 socket 建立后按它恢复暂停(onOpen)。
      transportPaused = paused;
      socket?.setReadPaused?.(paused);
    },
    isBridged: (deviceId) => (deviceId ? bridgeDevices.has(deviceId) : bridged),
    isRunning: () => running && !stopRequested,
    dispose() {
      running = false;
      stopRequested = true;
      clearHeartbeat();
      clearReconnectTimer();
      clearPendingControlFrames();
      try {
        socket?.close(1000, "desktop exiting");
      } catch {
        // 忽略退出路径上的 close 异常。
      }
      socket = null;
    },
  };
}
