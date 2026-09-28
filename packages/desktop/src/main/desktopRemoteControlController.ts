/* 手机远程控制 controller:Main 侧的鉴权/配对/attachment 调度 owner。
 * 边界(方案 specs/mobile-remote-control-cf-workers.md §总体架构):Main 只做出站连接、
 * 配对确认、attachment 调度与 WS↔port 帧泵;不承载任务/会话业务状态,不为手机另起
 * Agent/Local Host/远程会话。手机 attachment 走 attachRemoteWorkspaceSessionHost
 * (desktopRemoteSessions.ts:832,本 controller 是其首个生产调用方)。 */
/* eslint-disable max-lines -- 配对状态机、凭据持久化与 attachment 调度共享同一会话闭包,拆分会引入跨文件状态漂移。 */
import { createHash, randomBytes } from "node:crypto";
import {
  buildRemotePairingUrl,
  HostMessageTypes,
  normalizeRemoteControlWorkerBaseUrl,
  PlatformChannels,
  remoteControlConfigSchema,
  remotePairingStatePushSchema,
  type RemoteControlConfig,
  type RemoteControlConfigSetRequest,
  type RemoteControlConfigSetResult,
  type RemoteControlConfigSnapshot,
  type RemoteControlTestResult,
  type RemoteControlDevice,
  type RemoteControlPersistedDevice,
  type RemoteDevicesRefreshResult,
  type RemotePairingDecideRequest,
  type RemotePairingMirrorTarget,
  type RemotePairingStartRequest,
  type RemotePairingStartResult,
  type RemotePairingStatePush,
} from "@lcode/shared";
import {
  createRemoteControlFramePump,
  type RemoteControlFramePump,
} from "./desktopRemoteControlFramePump.js";
import {
  createRemoteControlTunnelSession,
  type RemoteControlTunnelSession,
} from "./desktopRemoteControlTunnel.js";
import {
  createRemoteControlStore,
  type RemoteControlCredentialService,
  type RemoteControlStore,
} from "./desktopRemoteControlStore.js";

/** pairing.requested 的桌面侧裁决窗口;超时只撤面板 pending 态,Worker 侧自带配对超时。 */
const PAIRING_DECISION_TIMEOUT_MS = 120_000;

export interface RemoteControlControllerLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

/** attachRemoteWorkspaceSessionHost 的注入面(测试用 fake 替代,避免依赖 electron runtime)。 */
export interface RemoteControlAttachmentPort {
  on(event: "message", listener: (event: { data: unknown }) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  start(): void;
  postMessage(data: Uint8Array): void;
  close(): void;
}

export interface RemoteControlAttachmentHostProcess {
  postMessage(message: Record<string, unknown>): void;
}

export interface RemoteControlControllerOptions {
  logger: RemoteControlControllerLogger;
  credentialService: RemoteControlCredentialService;
  /** 注入 attachRemoteWorkspaceSessionHost(main/index.ts 装配时传 remoteSessionManager 的方法)。 */
  attachRemoteWorkspaceSessionHost: (params: {
    windowId: number;
    remoteSessionId: string;
    workspacePath: string;
    workspaceIdentity: string;
    workspaceKey: string;
    clientMode: "web-remote-replayable";
  }) => {
    process: RemoteControlAttachmentHostProcess;
    port: RemoteControlAttachmentPort;
    remoteKind: string;
    attachmentId: string;
  };
  /** 本地工作区镜像:scope:{kind:"local"} 第二 attachment(与 Renderer 共存,不互斥)。 */
  attachLocalWorkspaceSessionHost: (params: { windowId: number }) => {
    process: RemoteControlAttachmentHostProcess;
    port: RemoteControlAttachmentPort;
    remoteKind: string;
    attachmentId: string;
  };
  /** 状态推送到全部应用窗口(Main 负责广播;Renderer 面板只消费)。 */
  broadcast: (channel: string, payload: RemotePairingStatePush) => void;
  now?: () => number;
  createTunnelSession?: typeof createRemoteControlTunnelSession;
  /** 「测试连接」的 HTTP 注入面(测试用 fake;默认全局 fetch)。 */
  fetchHealth?: (
    url: string,
    init: { method: "POST"; headers: Record<string, string>; signal: AbortSignal },
  ) => Promise<{ ok: boolean; status: number }>;
}

interface ActivePairingSession {
  roomId: string;
  capability: string;
  tunnel: RemoteControlTunnelSession;
  /** Worker 返回的房间过期时间;room.ready 之前用本地 TTL 估算。 */
  expiresAt: number;
  mirrorTarget?: RemotePairingMirrorTarget;
}

interface PendingPairingRequest {
  requestId: string;
  deviceName: string;
  ua: string;
  deadlineAt: number;
}

interface ActiveBridge {
  deviceId: string;
  attachmentId: string;
  port: RemoteControlAttachmentPort;
  process: RemoteControlAttachmentHostProcess;
  pump: RemoteControlFramePump;
}

export function createRemoteControlController(options: RemoteControlControllerOptions) {
  const now = options.now ?? (() => Date.now());
  const createTunnelSession = options.createTunnelSession ?? createRemoteControlTunnelSession;
  const store: RemoteControlStore = createRemoteControlStore({
    credentialService: options.credentialService,
    logger: options.logger,
  });
  let session: ActivePairingSession | null = null;
  let bridge: ActiveBridge | null = null;
  let pendingRequest: PendingPairingRequest | null = null;
  let pendingRequestTimer: NodeJS.Timeout | null = null;
  let idleDisconnectTimer: NodeJS.Timeout | null = null;
  /** 当前会话生效的空闲自动断开时长;桥结束/断开后按它重新布防(§3.4)。 */
  let activeIdleDisconnectMs = 0;
  let disposed = false;
  /** 最近一次推送的配对状态;config-get 快照用它回复"订阅前已发生的状态"(§6.3)。 */
  let lastPairingStatePush: RemotePairingStatePush | null = null;

  function pushState(state: RemotePairingStatePush): void {
    const validated = remotePairingStatePushSchema.parse(state);
    lastPairingStatePush = validated;
    try {
      options.broadcast(PlatformChannels.RemotePairingState, validated);
    } catch (error) {
      // 状态推送是旁路;广播失败不影响隧道/attachment 生命周期。
      options.logger.warn("[remote-control] push pairing state failed:", error);
    }
  }

  function clearPendingRequestTimer(): void {
    if (!pendingRequestTimer) return;
    clearTimeout(pendingRequestTimer);
    pendingRequestTimer = null;
  }

  function clearIdleDisconnectTimer(): void {
    if (!idleDisconnectTimer) return;
    clearTimeout(idleDisconnectTimer);
    idleDisconnectTimer = null;
  }

  function armIdleDisconnectTimer(idleDisconnectMs: number): void {
    clearIdleDisconnectTimer();
    if (idleDisconnectMs <= 0) return;
    // 空闲自动断开是桌面本地策略(PROTOCOL.md §3.4):配对等待期间无人扫码/无人桥接
    // 超过设置时长即 room.stop;桥接建立后不再受其约束,避免切断正在镜像的会话。
    idleDisconnectTimer = setTimeout(() => {
      idleDisconnectTimer = null;
      if (!session || bridge) return;
      options.logger.info("[remote-control] idle disconnect fired, stopping room", {
        roomId: session.roomId,
      });
      void stopPairing("idle-disconnect");
    }, idleDisconnectMs);
    idleDisconnectTimer.unref?.();
  }

  /** 先停泵再 detach-service-port,顺序不可倒置(PROTOCOL.md §6.4);幂等。 */
  function teardownBridge(reason: string): void {
    const current = bridge;
    if (!current) return;
    bridge = null;
    current.pump.stop();
    try {
      current.process.postMessage({
        type: HostMessageTypes.DetachServicePort,
        attachmentId: current.attachmentId,
      });
    } catch (error) {
      options.logger.warn("[remote-control] detach service port failed:", {
        attachmentId: current.attachmentId,
        reason,
        error,
      });
    }
    try {
      current.port.close();
    } catch {
      // port 已由对端关闭时 close 抛错属正常路径。
    }
    options.logger.info("[remote-control] bridge torn down", { reason });
    // 桥结束后房间可能仍存活(手机可凭设备凭据重连再次 bridged,§3.3);重新布防
    // 空闲自动断开,避免设置项在首次桥接结束后静默失效(§3.4)。stopPairing/dispose
    // 会在 teardown 之后再次清除/短路,不会误停刚要终止的会话。
    if (session && !disposed) {
      armIdleDisconnectTimer(activeIdleDisconnectMs);
    }
  }

  async function persistDevice(entry: {
    deviceId: string;
    deviceName: string;
    credHash: string;
    grantedAt: number;
  }): Promise<void> {
    try {
      const devices = await store.loadDevices();
      const next: RemoteControlPersistedDevice[] = [
        ...devices.filter((device) => device.deviceId !== entry.deviceId),
        {
          deviceId: entry.deviceId,
          deviceName: entry.deviceName,
          credHash: entry.credHash,
          grantedAt: entry.grantedAt,
          lastSeenAt: entry.grantedAt,
        },
      ];
      await store.saveDevices(next);
    } catch (error) {
      // 设备持久化失败只影响"免二次确认重连",不能回滚已建立的桥。
      options.logger.warn("[remote-control] persist paired device failed:", error);
    }
  }

  async function touchDeviceLastSeen(deviceId: string): Promise<void> {
    try {
      const devices = await store.loadDevices();
      const target = devices.find((device) => device.deviceId === deviceId);
      if (!target) return;
      target.lastSeenAt = now();
      await store.saveDevices(devices);
    } catch (error) {
      options.logger.warn("[remote-control] touch device lastSeenAt failed:", error);
    }
  }

  async function stopPairing(reason: string): Promise<void> {
    clearPendingRequestTimer();
    pendingRequest = null;
    // teardownBridge 会按 activeIdleDisconnectMs 重新布防空闲定时器;
    // 必须在其之后再清除并复位时长,避免刚终止的会话留下存活定时器。
    teardownBridge(reason);
    const current = session;
    session = null;
    activeIdleDisconnectMs = 0;
    clearIdleDisconnectTimer();
    if (current) {
      current.tunnel.stopRoom();
    }
    pushState({ state: "stopped" });
  }

  async function startPairing(
    request: RemotePairingStartRequest,
  ): Promise<RemotePairingStartResult> {
    if (disposed) {
      return { success: false, error: "REMOTE_CONTROL_DISPOSED" };
    }
    const persistedConfig = await store.loadConfig();
    if (!persistedConfig.enabled) {
      return { success: false, error: "REMOTE_CONTROL_DISABLED" };
    }
    const workerBaseUrl = normalizeRemoteControlWorkerBaseUrl(persistedConfig.workerBaseUrl);
    if (!workerBaseUrl) {
      return { success: false, error: "WORKER_BASE_URL_INVALID" };
    }
    const accessKey = await store.loadAccessKey();
    if (!accessKey) {
      return { success: false, error: "ACCESS_KEY_MISSING" };
    }

    // 重复 start 视为"刷新二维码":旧 room.stop + 新 roomId/capability(PROTOCOL.md §4.2.3)。
    void stopPairing("pairing-restart");
    // stopPairing 推过 stopped;重新开启等待会紧跟 waiting,面板无需特殊处理。

    const roomId = randomBytes(16).toString("base64url");
    const capability = randomBytes(32).toString("base64url");
    const capHash = createHash("sha256").update(capability).digest("base64url");
    const expiresAt = now() + persistedConfig.pairingTtlMs;
    const pairingUrl = buildRemotePairingUrl({ workerBaseUrl, roomId, capability });
    const mirrorTarget = request.target;
    const devices = await store.loadDevices();

    const tunnel = createTunnelSession(
      {
        workerBaseUrl,
        accessKey,
        roomId,
        capHash,
        ttlMs: persistedConfig.pairingTtlMs,
        devices: devices.map((device) => ({
          deviceId: device.deviceId,
          credHash: device.credHash,
          deviceName: device.deviceName,
        })),
      },
      {
        onRoomReady: (frame) => {
          if (session?.roomId !== roomId) return;
          session.expiresAt = frame.expiresAt;
          // 已桥接时 host socket 闪断重连(§3.3):DO 保留桥并忽略重发的 room.create,
          // 房间真实状态仍是 bridged,不能把面板推回 waiting(旧二维码已消费,重扫必拒)。
          if (bridge) return;
          pushState({ state: "waiting", roomId: frame.roomId, expiresAt: frame.expiresAt });
        },
        onPairingRequested: (frame) => {
          if (session?.roomId !== roomId) return;
          if (!persistedConfig.allowNewDevices) {
            // pairing.requested 必然来自未登记凭据的设备(已授权设备直接走 /ws + 凭据免确认
            // 重连,§4.3.2);允许新设备关闭时无需等待用户裁决,直接拒绝。
            options.logger.info("[remote-control] auto-reject pairing, new devices disabled", {
              deviceName: frame.deviceName,
            });
            tunnel.decide(frame.requestId, false, "new devices are not allowed");
            // capability 已消费(§2.2):推送 error 让面板感知本次拒绝,并与用户显式拒绝
            // 路径一致地立即重建房间,让面板回到可扫码状态而不是停在已失效的旧二维码。
            pushState({ state: "error", error: "NEW_DEVICE_REJECTED" });
            void startPairing({ target: session?.mirrorTarget })
              .then((result) => {
                if (!result.success) {
                  pushState({ state: "error", error: result.error });
                }
              })
              .catch((error: unknown) => {
                options.logger.warn(
                  "[remote-control] regenerate room after auto-reject failed:",
                  error,
                );
                pushState({ state: "error", error: "ROOM_REGENERATION_FAILED" });
              });
            return;
          }
          pendingRequest = {
            requestId: frame.requestId,
            deviceName: frame.deviceName,
            ua: frame.ua,
            deadlineAt: now() + PAIRING_DECISION_TIMEOUT_MS,
          };
          clearPendingRequestTimer();
          pendingRequestTimer = setTimeout(() => {
            pendingRequestTimer = null;
            if (!pendingRequest || !session) return;
            pendingRequest = null;
            // 桌面侧裁决窗口到点只撤 pending 展示;capability 已消费,重试需刷新二维码(§2.2)。
            pushState({ state: "waiting", roomId: session.roomId, expiresAt: session.expiresAt });
          }, PAIRING_DECISION_TIMEOUT_MS);
          pendingRequestTimer.unref?.();
          pushState({
            state: "pairing",
            roomId,
            pendingDevice: {
              requestId: frame.requestId,
              deviceName: frame.deviceName,
              ua: frame.ua,
            },
          });
        },
        onPairingAccepted: (frame) => {
          void persistDevice({
            deviceId: frame.deviceId,
            deviceName: frame.deviceName,
            credHash: frame.credHash,
            grantedAt: frame.grantedAt,
          });
        },
        onBridgeOpen: (frame) => {
          void handleBridgeOpen(roomId, frame.deviceId, frame.resumed);
        },
        onBridgeDetached: () => {
          // 宽限耗尽(或吊销命中)后 Worker 已断桥;桌面按契约执行 detach(§3.3/§6.4)。
          // 房间并未终止(session/tunnel 存活,手机仍可凭设备凭据重连再次 bridged),
          // 因此推送 error 而非 stopped——面板展示"桥已断开"的事实,不宣称会话已停止。
          if (session?.roomId !== roomId) return;
          teardownBridge("bridge-detached");
          pushState({ state: "error", error: "BRIDGE_DETACHED" });
        },
        onPeerDisconnected: (frame) => {
          // 手机 60s 重连宽限内保持 attachment,由 v4 replayable 订阅缓冲补齐断口(§3.3)。
          options.logger.info("[remote-control] phone disconnected, waiting for resume", {
            deviceId: frame.deviceId,
          });
          void touchDeviceLastSeen(frame.deviceId);
        },
        onRoomInvalidated: (frame) => {
          if (session?.roomId !== roomId) return;
          options.logger.warn("[remote-control] room invalidated", {
            roomId: frame.roomId,
            failCount: frame.failCount,
          });
          teardownBridge("room-invalidated");
          session = null;
          clearIdleDisconnectTimer();
          pushState({ state: "error", error: "ROOM_INVALIDATED" });
        },
        onRoomExpired: () => {
          if (session?.roomId !== roomId) return;
          teardownBridge("room-expired");
          session = null;
          clearIdleDisconnectTimer();
          pendingRequest = null;
          pushState({ state: "stopped", error: "ROOM_EXPIRED" });
        },
        onProtocolError: (frame) => {
          options.logger.warn("[remote-control] worker protocol error:", {
            code: frame.code,
            message: frame.message,
          });
        },
        onAuthRejected: () => {
          options.logger.warn("[remote-control] access key rejected by worker");
          if (session?.roomId !== roomId) return;
          session = null;
          clearIdleDisconnectTimer();
          pushState({ state: "error", error: "ACCESS_KEY_REJECTED" });
        },
        onTransportSuspended: (info) => {
          // host socket 闪断:DO 保留房间/桥 30s,帧泵自然静默,重连成功后恢复(§3.3)。
          options.logger.warn("[remote-control] host socket suspended, reconnecting", {
            code: info.code,
            graceDeadlineAt: info.graceDeadlineAt,
          });
        },
        onClosed: (info) => {
          if (session?.roomId !== roomId) return;
          teardownBridge("tunnel-closed");
          session = null;
          clearIdleDisconnectTimer();
          pendingRequest = null;
          pushState({
            state: "stopped",
            ...(info.code === 1000 ? {} : { error: `TUNNEL_CLOSED_${info.code}` }),
          });
        },
        onBridgeBinary: (data) => {
          bridge?.pump.handleWsBinary(data);
        },
      },
    );

    session = { roomId, capability, tunnel, expiresAt, mirrorTarget };
    activeIdleDisconnectMs = persistedConfig.idleDisconnectMs;
    armIdleDisconnectTimer(activeIdleDisconnectMs);
    return { success: true, roomId, pairingUrl, expiresAt };
  }

  function handleBridgeOpen(roomId: string, deviceId: string, resumed: boolean): void {
    const current = session;
    if (!current || disposed || current.roomId !== roomId) return;
    if (bridge) {
      if (bridge.deviceId === deviceId) {
        // 手机凭设备凭据在宽限内 resumed 重连(§3.3):复用既有 attachment 与帧泵,
        // 不重复 attach——否则旧 attachmentId 永远收不到 detach-service-port,
        // 在 windowHostAttachmentRegistry(按 attachmentId 共存)与 MessagePort 上泄漏,
        // 且旧 pump 会成为向同一条隧道 WS 写帧的第二条写入路径。
        clearIdleDisconnectTimer();
        void touchDeviceLastSeen(deviceId);
        // 手机页面 reload 后是全新 ChannelClient(Uninitialized):复用的 attachment
        // 不会重建 ChannelServer、也不会再发 Initialize,必须显式请求 host 重发,
        // 否则手机端所有 RPC 永久排队,镜像停在启动页(黑屏根因之二,§3.3)。
        bridge.process.postMessage({
          type: HostMessageTypes.ResendServicePortInit,
          attachmentId: bridge.attachmentId,
        });
        pushState({ state: "bridged", roomId: current.roomId });
        return;
      }
      // v1 每房间最多 1 条桥(§3.2 close 4008);不同设备再桥接属异常,防御性 fail-closed。
      options.logger.warn("[remote-control] second device tried to bridge, stopping room", {
        existingDeviceId: bridge.deviceId,
        incomingDeviceId: deviceId,
      });
      void stopPairing("second-bridge-device");
      pushState({ state: "error", error: "ROOM_BUSY" });
      return;
    }
    const mirrorTarget = current.mirrorTarget;
    if (!mirrorTarget) {
      // fail-closed:没有镜像目标就没有 attachment 端口,桥不能悬空挂着(无任何会话数据面)。
      options.logger.error("[remote-control] bridge opened without mirror target");
      void stopPairing("mirror-target-missing");
      pushState({ state: "error", error: "MIRROR_TARGET_MISSING" });
      return;
    }
    void touchDeviceLastSeen(deviceId);
    clearIdleDisconnectTimer();
    try {
      // 本地工作区走 scope:{kind:"local"} 第二 attachment(与 Renderer 共存);
      // 远程工作区走既有 remote 入口,三元组全等校验不变(PROTOCOL.md §6.2)。
      const attached =
        mirrorTarget.kind === "local"
          ? options.attachLocalWorkspaceSessionHost({ windowId: mirrorTarget.windowId })
          : options.attachRemoteWorkspaceSessionHost({
              windowId: mirrorTarget.windowId,
              remoteSessionId: mirrorTarget.remoteSessionId,
              workspacePath: mirrorTarget.workspacePath,
              workspaceIdentity: mirrorTarget.workspaceIdentity,
              // attach 入口以 workspaceKey === workspaceIdentity 做 fail-closed 校验
              // (desktopRemoteSessions.ts:865-873);镜像目标恒携带 identity。
              workspaceKey: mirrorTarget.workspaceIdentity,
              clientMode: "web-remote-replayable",
            });
      const pump = createRemoteControlFramePump({
        ws: {
          sendBinary: (data) => current.tunnel.sendBridgeBinary(data),
          close: (code, reason) => current.tunnel.close(code, reason),
        },
        port: { postMessage: (data) => attached.port.postMessage(data) },
        setTransportPaused: (paused) => current.tunnel.setTransportPaused(paused),
        onViolation: (info) => {
          options.logger.warn("[remote-control] frame pump violation:", info);
        },
        onViolationLimit: () => {
          teardownBridge("frame-pump-violation-limit");
          pushState({ state: "error", error: "FRAME_PROTOCOL_VIOLATION" });
        },
      });
      attached.port.on("message", (event) => {
        pump.handlePortMessage(event.data);
      });
      attached.port.on("close", () => {
        // Host 侧先行关闭(session 释放/Host 退出):本地桥同步收口,避免帧泵入已死端口。
        if (bridge?.port === attached.port) {
          teardownBridge("host-port-closed");
        }
      });
      attached.port.start();
      bridge = {
        deviceId,
        attachmentId: attached.attachmentId,
        port: attached.port,
        process: attached.process,
        pump,
      };
      options.logger.info("[remote-control] bridge attached", {
        deviceId,
        resumed,
        attachmentId: attached.attachmentId,
        mirrorKind: mirrorTarget.kind,
        remoteSessionId: mirrorTarget.kind === "remote" ? mirrorTarget.remoteSessionId : null,
      });
      pushState({ state: "bridged", roomId: current.roomId });
    } catch (error) {
      // 四类 fail-closed code 原样映射到 UI(PROTOCOL.md §6.2)。
      const code = (error as { code?: string }).code;
      const normalized = code ?? "ATTACH_FAILED";
      options.logger.warn("[remote-control] attach remote workspace session host failed:", {
        code: normalized,
        error,
      });
      void stopPairing("attach-failed");
      pushState({ state: "error", error: normalized });
    }
  }

  async function decidePairing(request: RemotePairingDecideRequest): Promise<void> {
    const current = session;
    if (!current) return;
    if (pendingRequest?.requestId !== request.requestId) return;
    // 同一 requestId 只生效一次(§2.2);tunnel 内部亦有幂等保护。
    pendingRequest = null;
    clearPendingRequestTimer();
    current.tunnel.decide(request.requestId, request.accept);
    if (request.accept) {
      // accept 后等 Worker 的 bridge.open;面板保持 pairing 态。
      pushState({ state: "pairing", roomId: current.roomId });
      return;
    }
    // accept/reject/超时后 capability 均已消费,重试必须重新生成二维码(§2.2):
    // 这里立即以同目标重建房间,让面板直接回到可扫码状态。
    try {
      const result = await startPairing({ target: current.mirrorTarget });
      if (!result.success) {
        pushState({ state: "error", error: result.error });
      }
    } catch (error) {
      options.logger.warn("[remote-control] regenerate room after reject failed:", error);
      pushState({ state: "error", error: "ROOM_REGENERATION_FAILED" });
    }
  }

  async function refreshDevices(): Promise<RemoteDevicesRefreshResult> {
    const devices = await store.loadDevices();
    return {
      devices: devices.map(
        (device): RemoteControlDevice => ({
          deviceId: device.deviceId,
          deviceName: device.deviceName,
          grantedAt: device.grantedAt,
          lastSeenAt: device.lastSeenAt,
        }),
      ),
    };
  }

  async function revokeDevice(deviceId: string): Promise<void> {
    const devices = await store.loadDevices();
    const next = devices.filter((device) => device.deviceId !== deviceId);
    await store.saveDevices(next);
    // 吊销必须一条 WS RTT 内生效(§4.3.3);本地同时拆桥做双保险(teardown 幂等)。
    if (bridge?.deviceId === deviceId) {
      teardownBridge("device-revoked");
    }
    session?.tunnel.revokeDevice(deviceId);
    options.logger.info("[remote-control] device revoked", { deviceId });
  }

  async function getConfig(): Promise<RemoteControlConfig> {
    const persisted = await store.loadConfig();
    const accessKey = await store.loadAccessKey();
    return remoteControlConfigSchema.parse({
      enabled: persisted.enabled,
      workerBaseUrl: persisted.workerBaseUrl,
      hasAccessKey: accessKey !== null,
      pairingTtlMs: persisted.pairingTtlMs,
      allowNewDevices: persisted.allowNewDevices,
      idleDisconnectMs: persisted.idleDisconnectMs,
    });
  }

  async function getConfigSnapshot(): Promise<RemoteControlConfigSnapshot> {
    const config = await getConfig();
    // waiting 态的 capability 尚未消费(§2.2),快照附带配对链接以恢复二维码/复制;
    // 其余状态 capability 已作废,链接置空,重挂载面板走"刷新二维码"。
    const pairingUrl =
      lastPairingStatePush?.state === "waiting" && session
        ? buildRemotePairingUrl({
            workerBaseUrl: config.workerBaseUrl,
            roomId: session.roomId,
            capability: session.capability,
          })
        : null;
    return { ...config, pairing: lastPairingStatePush, pairingUrl };
  }

  /** 「测试连接」:Main 持接入 Key 调 Worker `POST /api/health`(§1),Renderer 不自行直连。 */
  async function testConnection(): Promise<RemoteControlTestResult> {
    const config = await getConfig();
    if (!config.enabled) return { success: false, error: "DISABLED" };
    const base = normalizeRemoteControlWorkerBaseUrl(config.workerBaseUrl);
    if (!base) return { success: false, error: "WORKER_BASE_URL_INVALID" };
    const accessKey = await store.loadAccessKey();
    if (!accessKey) return { success: false, error: "ACCESS_KEY_MISSING" };
    const startedAt = now();
    try {
      const fetchHealth = options.fetchHealth ?? ((url, init) => fetch(url, init));
      const response = await fetchHealth(`${base}/api/health`, {
        method: "POST",
        headers: { "x-lcode-remote-access-key": accessKey },
        signal: AbortSignal.timeout(8000),
      });
      const latencyMs = Math.max(0, now() - startedAt);
      if (response.ok) return { success: true, latencyMs };
      if (response.status === 401) {
        // 401 同时覆盖"Key 不对"与"Worker 侧 secret 未配置",提示需两端核对
        return { success: false, error: "AUTH_REJECTED", latencyMs };
      }
      return { success: false, error: `HTTP_${response.status}`, latencyMs };
    } catch (error) {
      return {
        success: false,
        error: `NETWORK:${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async function setConfig(
    request: RemoteControlConfigSetRequest,
  ): Promise<RemoteControlConfigSetResult> {
    const persisted = await store.loadConfig();
    if (request.workerBaseUrl !== undefined) {
      if (!normalizeRemoteControlWorkerBaseUrl(request.workerBaseUrl)) {
        return { success: false, error: "WORKER_BASE_URL_INVALID" };
      }
    }
    if (request.accessKey !== undefined) {
      // 接入 Key 只进凭据集中存储:不落明文配置、不进日志、不回读(§6.3)。
      // 存前 trim:粘贴时常带入首尾空白/换行,会导致与 Worker secret 恒定时间比较 401。
      const accessKey = request.accessKey.trim();
      if (accessKey.length < 32) {
        return { success: false, error: "ACCESS_KEY_INVALID" };
      }
      await store.saveAccessKey(accessKey);
    }
    const next = {
      enabled: request.enabled ?? persisted.enabled,
      workerBaseUrl: request.workerBaseUrl ?? persisted.workerBaseUrl,
      pairingTtlMs: request.pairingTtlMs ?? persisted.pairingTtlMs,
      allowNewDevices: request.allowNewDevices ?? persisted.allowNewDevices,
      idleDisconnectMs: request.idleDisconnectMs ?? persisted.idleDisconnectMs,
    };
    await store.saveConfig(next);
    // 设置禁用后立即断开出站且不再重连(验收 specs/mobile-remote-control-cf-workers.md:88)。
    if (!next.enabled && session) {
      void stopPairing("remote-control-disabled");
    }
    return { success: true };
  }

  /** 桌面退出/禁用:主动关闭房间并断开出站(方案 §桌面端改动 4);尽力而为不阻塞退出。 */
  function dispose(reason: string): void {
    if (disposed) return;
    disposed = true;
    clearPendingRequestTimer();
    clearIdleDisconnectTimer();
    pendingRequest = null;
    // disposed 已置位,teardownBridge 内的空闲定时器重新布防会被短路。
    teardownBridge(reason);
    // stopRoom 先发 room.stop 再关闭(一条 WS RTT 内生效,§4.3.3);全部为同步尽力发送。
    try {
      session?.tunnel.stopRoom();
    } catch {
      // 退出路径上的发送失败不阻塞 quit。
    }
    session = null;
    activeIdleDisconnectMs = 0;
  }

  return {
    startPairing,
    stopPairing,
    decidePairing,
    refreshDevices,
    revokeDevice,
    getConfig,
    getConfigSnapshot,
    testConnection,
    setConfig,
    dispose,
    /** 诊断/测试用。 */
    getActiveState(): {
      hasSession: boolean;
      hasBridge: boolean;
      pendingRequestId: string | null;
    } {
      return {
        hasSession: session !== null,
        hasBridge: bridge !== null,
        pendingRequestId: pendingRequest?.requestId ?? null,
      };
    },
  };
}
