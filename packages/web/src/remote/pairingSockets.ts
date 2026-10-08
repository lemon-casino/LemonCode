import { connectViaWebSocket, type WebSocketConnectionCloseEvent } from "@lcode/client";
import {
  describePairingClose,
  parsePairingControlFrame,
  type PairingFailureKey,
} from "./pairingFrames.js";

/**
 * 手机侧与 Worker 的两条套接字(cfworker-remote/PROTOCOL.md §1.1):
 * - 配对套接字 `WS /ws/pair?roomId&auth`:一次性 capability 走 URL query
 *   (浏览器无法设置自定义 header),只收 JSON TEXT 控制帧,任何终态后由 Worker close 1000;
 * - 数据套接字 `WS /ws?roomId&auth`:与 packages/web 既有连接目标同路径同格式,
 *   复用未改动的 `connectViaWebSocket` 流程,鉴权参数 URL 化
 *   (connectViaWebSocket open 后立即进入 SocketProtocol 流,无首帧鉴权窗口)。
 */

// 同源 ws(s)://<host> 构造,与 main.tsx 的 resolveDefaultWsOrigin 保持一致(§1.1 同源约束)。
function resolveSameOriginWsUrl(pathWithQuery: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${pathWithQuery}`;
}

export function buildPairingSocketUrl(roomId: string, capability: string): string {
  return resolveSameOriginWsUrl(
    `/ws/pair?roomId=${encodeURIComponent(roomId)}&auth=${encodeURIComponent(capability)}`,
  );
}

export function buildDataSocketUrl(roomId: string, deviceCredential: string): string {
  return resolveSameOriginWsUrl(
    `/ws?roomId=${encodeURIComponent(roomId)}&auth=${encodeURIComponent(deviceCredential)}`,
  );
}

export type MobileDataServices = Awaited<ReturnType<typeof connectViaWebSocket>>;

export type PairingSocketOutcome =
  | { kind: "accepted"; deviceId: string; deviceCredential: string }
  | { kind: "rejected"; reason?: string }
  | { kind: "worker-error"; message?: string }
  | { kind: "failed"; key: PairingFailureKey };

// 房间 TTL 默认 5 分钟(§4.2),到期 Worker 主动 close 4005;此处超时只是
// 对"套接字静默死亡且无 close 事件"这类网络异常的兜底,取远大于 TTL 的值。
const PAIRING_SOCKET_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * 打开配对套接字并等待桌面裁决。仅消费 §2.2 词表内的帧:
 * pairing.accepted / pairing.rejected / error;room.* 帧按契约发往桌面,
 * 但若 Worker 直发手机也按同义失败映射,避免无谓等待到超时。
 */
export function openPairingSocket(url: string, onOpen: () => void): Promise<PairingSocketOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const ws = new WebSocket(url);
    const finish = (outcome: PairingSocketOutcome) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      try {
        ws.close();
      } catch {
        // close 事件竞态:套接字已在关闭流程中
      }
      resolve(outcome);
    };
    const timeout = setTimeout(
      () => finish({ kind: "failed", key: "timeout" }),
      PAIRING_SOCKET_TIMEOUT_MS,
    );

    ws.addEventListener("open", () => onOpen());
    ws.addEventListener("message", (event) => {
      const frame = parsePairingControlFrame(event.data);
      if (!frame) {
        return;
      }
      if (frame.type === "pairing.accepted") {
        // 凭据明文唯一一次下发(§4.1);字段不完整按协议违规处理,避免半凭据落存储
        if (typeof frame.deviceId === "string" && typeof frame.deviceCredential === "string") {
          finish({
            kind: "accepted",
            deviceId: frame.deviceId,
            deviceCredential: frame.deviceCredential,
          });
        } else {
          finish({ kind: "failed", key: "protocol" });
        }
        return;
      }
      if (frame.type === "pairing.rejected") {
        finish({
          kind: "rejected",
          reason: typeof frame.reason === "string" ? frame.reason : undefined,
        });
        return;
      }
      if (frame.type === "error") {
        finish({
          kind: "worker-error",
          message: typeof frame.message === "string" ? frame.message : undefined,
        });
        return;
      }
      if (frame.type === "room.expired" || frame.type === "room.invalidated") {
        finish({ kind: "failed", key: frame.type === "room.expired" ? "expired" : "invalidated" });
      }
      // 其余控制帧(如 pong)忽略
    });
    // 连接失败时浏览器在 error 事件后必发 close,失败信息统一由 close 事件的 code 承载
    ws.addEventListener("close", (event) => {
      if (event.code === 1000 || event.code === 1006 || event.code === 1015) {
        // 终态帧路径已在 message 中 settle;走到这里是未经终态帧的断链
        finish({ kind: "failed", key: "network" });
        return;
      }
      finish({ kind: "failed", key: describePairingClose(event.code, event.reason) });
    });
  });
}

const HEARTBEAT_INTERVAL_MS = 30_000; // §3.4:手机数据套接字每 30s 一条 TEXT {"type":"ping"}
const BRIDGE_OPEN_TIMEOUT_MS = 15_000; // bridge.open 是授权后 Worker 的首帧,超时视为建桥失败

export class MobileBridgeError extends Error {
  constructor(
    readonly key: PairingFailureKey,
    detail?: string,
  ) {
    super(detail ? `${key}: ${detail}` : key);
    this.name = "MobileBridgeError";
  }
}

/**
 * 建立桥接数据套接字:复用既有 connectViaWebSocket,在其 open 后等待 Worker 的
 * TEXT `bridge.open` 再把 services 交给调用方——§2.3 规定 bridge.open 之前手机数据
 * 套接字上出现 BINARY 即 close 4003,因此必须等桥建立后才允许应用层发帧
 * (getChannel 为惰性代理,首个二进制帧只会在 app shell 渲染后发出)。
 * 心跳按 §3.4 由本模块持有:每 30s 发 TEXT `{"type":"ping"}`,断链时停止。
 * `onDisconnected` 在接管后(settled)断链时携带语义化失败 key 回调,供调用方
 * 执行 §3.3 的重连监督;未提供时保持既有 web 行为(静默)。
 * Worker 下发的 TEXT 帧(bridge.open/pong)经 wrapBrowserWebSocket 的
 * `new Uint8Array(string)` 得到 0 长度 buffer,SocketProtocol 视为空分片,无副作用。
 */
export function connectBridgedDataSocket(
  url: string,
  onDisconnected?: (closeKey: PairingFailureKey) => void,
): Promise<MobileDataServices> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let connected = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let socket: WebSocket | undefined;
    let resolveBridgeOpen: (() => void) | undefined;

    const stopHeartbeat = () => {
      if (heartbeat !== undefined) {
        clearInterval(heartbeat);
        heartbeat = undefined;
      }
    };
    const fail = (key: PairingFailureKey, detail?: string) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(bridgeTimeout);
      stopHeartbeat();
      try {
        socket?.close();
      } catch {
        // 套接字可能已在关闭流程中
      }
      reject(new MobileBridgeError(key, detail));
    };
    const bridgeTimeout = setTimeout(() => fail("bridge-timeout"), BRIDGE_OPEN_TIMEOUT_MS);
    const bridgeOpen = new Promise<void>((resolveBridge) => {
      resolveBridgeOpen = resolveBridge;
    });

    void connectViaWebSocket(url, {
      onClose: (event: WebSocketConnectionCloseEvent) => {
        stopHeartbeat();
        if (!settled) {
          fail(describePairingClose(event.code, event.reason), event.reason || undefined);
          return;
        }
        // 接管后断链:交给调用方的重连监督者执行 §3.3 的 resumed 重连;
        // 未提供回调时保持既有 web 行为(静默,无重连执行者)。
        // 超时拒绝也会 settled，但未交付 services；不能因此刷新整页打断原重试。
        if (connected) onDisconnected?.(describePairingClose(event.code, event.reason));
      },
      onOpenSocket: (ws) => {
        socket = ws;
        heartbeat = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send('{"type":"ping"}');
          }
        }, HEARTBEAT_INTERVAL_MS);
        ws.addEventListener("message", (event) => {
          if (parsePairingControlFrame(event.data)?.type === "bridge.open") {
            resolveBridgeOpen?.();
          }
        });
      },
    }).then(
      (services) => {
        void bridgeOpen.then(() => {
          if (settled) {
            return;
          }
          settled = true;
          connected = true;
          clearTimeout(bridgeTimeout);
          resolve(services);
        });
      },
      () => {
        // open 前失败:close/error 已先经 fail() 携带关闭码;这里兜底非 close 路径的 reject
        fail("network");
      },
    );
  });
}
