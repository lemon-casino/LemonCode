/* 帧泵:Worker WS(SocketProtocol 13B 帧)↔ 窗口 Host attachment port(MessagePortProtocol)的唯一翻译点。
 * 契约:cfworker-remote/PROTOCOL.md §6.4 —— 手机→Host 校验 13B 头后剥出 payload postMessage;
 * Host→手机把每条 Uint8Array 包成 Regular 帧写入 WS;port 流控对象永不穿越 WS,仅用于自身反压;
 * 非法帧丢弃并计数,连续违规断开。本模块保持纯函数化(不 import electron/ws),便于单元测试。 */
import { PROTOCOL_V4_LIMITS } from "@lcode/shared/lcode-protocol-v4";

/** SocketProtocol 13 字节帧头(type:u8 + id:u32BE + ack:u32BE + length:u32BE)。 */
export const REMOTE_CONTROL_WS_HEADER_SIZE = 13;
/** 帧泵在 WS 侧只接受 Regular 数据帧;其他帧类型视为协议违规(PROTOCOL.md §6.4)。 */
const REGULAR_FRAME_TYPE = 1;

/** port 内部流控对象(connection-flow-v1);与 packages/rpc MessagePortProtocol 的判定同构。 */
export interface RemoteControlFlowControlMessage {
  __lcodeRpcControl: "connection-flow-v1";
  state: "saturated" | "drained";
}

function isFlowControlMessage(value: unknown): value is RemoteControlFlowControlMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.__lcodeRpcControl === "connection-flow-v1" &&
    (record.state === "saturated" || record.state === "drained") &&
    Object.keys(record).length === 2
  );
}

export interface RemoteControlFramePumpWsSide {
  /** Host→手机方向:把完整 Regular 帧(含 13B 头)写入 WS。 */
  sendBinary(data: Uint8Array): void;
  /** 协议违规达到阈值时的断开入口;由上层决定 stop 房间还是只关桥。 */
  close(code: number, reason: string): void;
}

export interface RemoteControlFramePumpPortSide {
  /** 手机→Host 方向:已剥头的 Channel payload。 */
  postMessage(data: Uint8Array): void;
}

export interface RemoteControlFramePump {
  /** WS 侧 BINARY 帧入口(Worker 桥透传的手机帧)。 */
  handleWsBinary(data: Uint8Array): void;
  /** port 侧消息入口(Host attachment 发出的消息,含流控对象)。 */
  handlePortMessage(data: unknown): void;
  /**
   * 反压执行点:port 流控对象到达时由上层暂停/恢复底层 WS 读(§6.4 暂停读 WS);
   * 帧泵自身不缓存业务帧,暂停期间到达的帧由传输层停读保证不丢。
   */
  setSuspended(suspended: boolean): void;
  /** 幂等停泵;detach-service-port 必须在 stop 之后(PROTOCOL.md §6.4 顺序不可倒置)。 */
  stop(): void;
  isStopped(): boolean;
}

export interface RemoteControlFramePumpOptions {
  ws: RemoteControlFramePumpWsSide;
  port: RemoteControlFramePumpPortSide;
  /** 桥接数据帧上限(PROTOCOL.md §2.1:1 MiB)。 */
  maxFrameBytes?: number;
  /** 连续违规断开阈值;契约未固定数值,取与房间失败计数一致的 5。 */
  maxConsecutiveViolations?: number;
  /** 每次违规(丢弃帧)时回调;consecutiveCount 达到阈值后回调 onViolationLimit。 */
  onViolation?(info: { reason: string; consecutiveCount: number }): void;
  onViolationLimit?(): void;
  /** 反压执行点(暂停/恢复底层 WS 读)。缺省时反压降级为 no-op(不缓存、不丢弃)。 */
  setTransportPaused?(paused: boolean): void;
}

function writeUInt32BE(target: Uint8Array, value: number, offset: number): void {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

export function createRemoteControlFramePump(
  options: RemoteControlFramePumpOptions,
): RemoteControlFramePump {
  const maxFrameBytes = options.maxFrameBytes ?? PROTOCOL_V4_LIMITS.maxFrameBytes;
  const maxConsecutiveViolations = options.maxConsecutiveViolations ?? 5;
  let consecutiveViolations = 0;
  let violationLimitReported = false;
  let transportPaused = false;
  let suspended = false;
  let stopped = false;

  function recordViolation(reason: string): void {
    consecutiveViolations += 1;
    options.onViolation?.({ reason, consecutiveCount: consecutiveViolations });
    if (consecutiveViolations >= maxConsecutiveViolations && !violationLimitReported) {
      // 连续违规断开:通知上层先停泵再 detach,同时关闭 WS(§6.4)。
      violationLimitReported = true;
      options.onViolationLimit?.();
      try {
        options.ws.close(4003, "frame-pump protocol violation");
      } catch {
        // close 失败不影响停泵语义;socket 生命周期由上层兜底。
      }
    }
  }

  return {
    handleWsBinary(data: Uint8Array): void {
      if (stopped) return;
      // 停泵/反压/违规断开后到达的迟到帧一律忽略;不缓存业务帧。
      if (suspended) return;
      if (data.byteLength < REMOTE_CONTROL_WS_HEADER_SIZE) {
        recordViolation("frame-shorter-than-header");
        return;
      }
      const frameType = data[0];
      if (frameType !== REGULAR_FRAME_TYPE) {
        recordViolation(`unsupported-frame-type-${frameType}`);
        return;
      }
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const length = view.getUint32(9);
      if (length > maxFrameBytes) {
        recordViolation("frame-exceeds-limit");
        return;
      }
      if (REMOTE_CONTROL_WS_HEADER_SIZE + length !== data.byteLength) {
        // 单条 WS message 必须是一个完整帧,不做跨 message 拼接(§2.1)。
        recordViolation("frame-length-mismatch");
        return;
      }
      consecutiveViolations = 0;
      // 剥头后复制 payload,避免依赖 ws 底层 Buffer 的复用时序。
      const payload = new Uint8Array(length);
      payload.set(
        new Uint8Array(data.buffer, data.byteOffset + REMOTE_CONTROL_WS_HEADER_SIZE, length),
      );
      try {
        options.port.postMessage(payload);
      } catch {
        // postMessage 失败(端口已关闭)按违规处理,让连续失败走断开路径。
        recordViolation("port-post-message-failed");
      }
    },

    handlePortMessage(data: unknown): void {
      if (stopped) return;
      if (isFlowControlMessage(data)) {
        // 流控对象不转发:port saturated → 暂停读 WS;drained → 恢复(§6.4)。
        const paused = data.state === "saturated";
        if (transportPaused !== paused) {
          transportPaused = paused;
          options.setTransportPaused?.(paused);
        }
        return;
      }
      if (suspended) return;
      if (!(data instanceof Uint8Array)) {
        // 未知 port 消息不穿越 WS;只有真实 Uint8Array 才是 RPC binary。
        recordViolation("port-non-binary-message");
        return;
      }
      if (data.byteLength > maxFrameBytes) {
        recordViolation("frame-exceeds-limit");
        return;
      }
      // Host→手机:每条 Uint8Array 包成 Regular 帧(type:1, id:0, ack:0)写入 WS(§6.4)。
      const frame = new Uint8Array(REMOTE_CONTROL_WS_HEADER_SIZE + data.byteLength);
      frame[0] = REGULAR_FRAME_TYPE;
      writeUInt32BE(frame, 0, 1);
      writeUInt32BE(frame, 0, 5);
      writeUInt32BE(frame, data.byteLength, 9);
      frame.set(data, REMOTE_CONTROL_WS_HEADER_SIZE);
      try {
        options.ws.sendBinary(frame);
      } catch {
        recordViolation("ws-send-failed");
      }
    },

    setSuspended(next: boolean): void {
      suspended = next;
    },

    stop(): void {
      stopped = true;
      if (transportPaused) {
        transportPaused = false;
        options.setTransportPaused?.(false);
      }
    },

    isStopped(): boolean {
      return stopped;
    },
  };
}

/** 组装一个 SocketProtocol Regular 帧(帧泵与测试共用;与 packages/rpc writeProtocolMessage 同构)。 */
export function encodeRemoteControlRegularFrame(payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(REMOTE_CONTROL_WS_HEADER_SIZE + payload.byteLength);
  frame[0] = REGULAR_FRAME_TYPE;
  writeUInt32BE(frame, 0, 1);
  writeUInt32BE(frame, 0, 5);
  writeUInt32BE(frame, payload.byteLength, 9);
  frame.set(payload, REMOTE_CONTROL_WS_HEADER_SIZE);
  return frame;
}
