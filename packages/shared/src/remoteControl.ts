/* 手机远程控制(CF Workers 隧道)协议类型与校验。
 * 契约唯一事实源:cfworker-remote/PROTOCOL.md(§2 控制帧、§4 凭据、§5 配对 URL、§6.3 桌面内部 IPC)。
 * 本文件只覆盖 Desktop Main 侧需要序列化/校验的契约面;Worker DO 内部状态不在此建模。 */
import { z } from "zod";
import { nonEmptyStringSchema } from "./validation.js";

/** 控制帧协议版本位;每条 socket 的第一个控制帧必须携带 proto:1(PROTOCOL.md §1.2)。 */
export const REMOTE_CONTROL_PROTO_VERSION = 1;
/** 官方托管远程控制服务；客户端不得内置该服务的共享接入密钥。 */
export const DEFAULT_REMOTE_CONTROL_WORKER_BASE_URL = "https://code.lemon.vin";
/** 配对链接默认有效期 = 房间 TTL(PROTOCOL.md §4.2;不是 hostCapability 的 30s)。 */
export const DEFAULT_REMOTE_CONTROL_PAIRING_TTL_MS = 300_000;
/** room.create 携带的已授权设备凭据哈希上限(PROTOCOL.md §4.3.2)。 */
export const REMOTE_CONTROL_MAX_PERSISTED_DEVICES = 64;
/** deviceName 由手机端从 UA 派生,Worker 侧保证去控制字符后的长度上限(PROTOCOL.md §2.2)。 */
export const REMOTE_CONTROL_DEVICE_NAME_MAX_LENGTH = 64;
export const REMOTE_CONTROL_UA_MAX_LENGTH = 256;
/** 配对 URL 的 capability 固定经 fragment 传递,键名 c= 留扩展位(PROTOCOL.md §5)。 */
export const REMOTE_CONTROL_PAIRING_FRAGMENT_KEY = "c";

const base64UrlSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9_-]+$/, "must be base64url");

/** deviceName/ua 由手机端从 UA 派生,Worker 保证去控制字符;桌面侧入库前同样拒绝控制字符。
 * 逐字符判断避免安全正则本身触发 lint 的 no-control-regex 警告(与 officeFilePreview 同做法)。 */
function assertNoControlCharacters(value: string): boolean {
  for (const char of value) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) {
      return false;
    }
  }
  return true;
}

// ============================================================================
// Worker 控制帧词表 —— 桌面 host socket 上发送/接收的 TEXT 帧(PROTOCOL.md §2.2/§2.3)
// ============================================================================

/** 桌面 → Worker:注册房间;devices 为跨房间免二次确认重连的已授权设备哈希表(§4.3.2)。 */
export const remoteControlRoomCreateFrameSchema = z
  .object({
    type: z.literal("room.create"),
    proto: z.literal(REMOTE_CONTROL_PROTO_VERSION),
    roomId: base64UrlSchema,
    capHash: base64UrlSchema,
    ttlMs: z.number().int().positive(),
    devices: z
      .array(
        z
          .object({
            deviceId: nonEmptyStringSchema,
            credHash: base64UrlSchema,
            deviceName: z.string().max(REMOTE_CONTROL_DEVICE_NAME_MAX_LENGTH),
          })
          .strict(),
      )
      .max(REMOTE_CONTROL_MAX_PERSISTED_DEVICES),
  })
  .strict();
export type RemoteControlRoomCreateFrame = z.infer<typeof remoteControlRoomCreateFrameSchema>;

/** 桌面 → Worker:停止房间;所有 socket 关闭,手机侧 close 4007(§4.3.3)。 */
export const remoteControlRoomStopFrameSchema = z.object({ type: z.literal("room.stop") }).strict();
export type RemoteControlRoomStopFrame = z.infer<typeof remoteControlRoomStopFrameSchema>;

/** 桌面 → Worker:吊销设备;若正在桥接立即 close 4007 + bridge.detached(§4.3.3)。 */
export const remoteControlDeviceRevokeFrameSchema = z
  .object({ type: z.literal("device.revoke"), deviceId: nonEmptyStringSchema })
  .strict();
export type RemoteControlDeviceRevokeFrame = z.infer<typeof remoteControlDeviceRevokeFrameSchema>;

/** 桌面 → Worker:接受配对;requestId 由 Worker 生成,accept/reject 只生效一次(§2.2)。 */
export const remoteControlPairingAcceptFrameSchema = z
  .object({ type: z.literal("pairing.accept"), requestId: nonEmptyStringSchema })
  .strict();
export type RemoteControlPairingAcceptFrame = z.infer<typeof remoteControlPairingAcceptFrameSchema>;

/** 桌面 → Worker:拒绝配对;capability 无论 accept/reject 均已消费(§2.2)。 */
export const remoteControlPairingRejectFrameSchema = z
  .object({
    type: z.literal("pairing.reject"),
    requestId: nonEmptyStringSchema,
    reason: z.string().max(256),
  })
  .strict();
export type RemoteControlPairingRejectFrame = z.infer<typeof remoteControlPairingRejectFrameSchema>;

/** 双端 → Worker:心跳帧;桥接后的手机数据套接字上 TEXT 仅允许 ping/pong(§3.4)。 */
export const remoteControlPingFrameSchema = z.object({ type: z.literal("ping") }).strict();
export const remoteControlPongFrameSchema = z.object({ type: z.literal("pong") }).strict();
export type RemoteControlPingFrame = z.infer<typeof remoteControlPingFrameSchema>;
export type RemoteControlPongFrame = z.infer<typeof remoteControlPongFrameSchema>;

/** Worker → 桌面:房间注册 ack(§2.2)。 */
export const remoteControlRoomReadyFrameSchema = z
  .object({
    type: z.literal("room.ready"),
    proto: z.literal(REMOTE_CONTROL_PROTO_VERSION),
    roomId: base64UrlSchema,
    // 已桥接房间不再受配对 TTL 限制，Worker 重连返回 null 是既有合法协议。
    expiresAt: z.number().int().positive().nullable(),
  })
  .strict();
export type RemoteControlRoomReadyFrame = z.infer<typeof remoteControlRoomReadyFrameSchema>;

/** Worker → 桌面:手机已扫码并出示 capability,等待桌面用户裁决(§2.2)。 */
export const remoteControlPairingRequestedFrameSchema = z
  .object({
    type: z.literal("pairing.requested"),
    proto: z.literal(REMOTE_CONTROL_PROTO_VERSION),
    requestId: nonEmptyStringSchema,
    roomId: base64UrlSchema,
    deviceName: z
      .string()
      .min(1)
      .max(REMOTE_CONTROL_DEVICE_NAME_MAX_LENGTH)
      .refine(assertNoControlCharacters, "must not contain control characters"),
    ua: z
      .string()
      .max(REMOTE_CONTROL_UA_MAX_LENGTH)
      .refine(assertNoControlCharacters, "must not contain control characters"),
  })
  .strict();
export type RemoteControlPairingRequestedFrame = z.infer<
  typeof remoteControlPairingRequestedFrameSchema
>;

/** Worker → 桌面:配对已被接受;凭据明文只发给手机,桌面仅收哈希(§2.2/§4.3.1)。 */
export const remoteControlPairingAcceptedFrameSchema = z
  .object({
    type: z.literal("pairing.accepted"),
    requestId: nonEmptyStringSchema,
    roomId: base64UrlSchema,
    deviceId: nonEmptyStringSchema,
    deviceName: z.string().max(REMOTE_CONTROL_DEVICE_NAME_MAX_LENGTH),
    credHash: base64UrlSchema,
    grantedAt: z.number().int().positive(),
  })
  .strict();
export type RemoteControlPairingAcceptedFrame = z.infer<
  typeof remoteControlPairingAcceptedFrameSchema
>;

/** Worker → 桌面:鉴权失败达阈值,房间作废;桌面必须重新生成房间(§3.1)。 */
export const remoteControlRoomInvalidatedFrameSchema = z
  .object({
    type: z.literal("room.invalidated"),
    roomId: base64UrlSchema,
    failCount: z.number().int().nonnegative(),
    reason: z.string(),
  })
  .strict();
export type RemoteControlRoomInvalidatedFrame = z.infer<
  typeof remoteControlRoomInvalidatedFrameSchema
>;

/** Worker → 桌面:waiting/pairing 超过 TTL(§3.1)。 */
export const remoteControlRoomExpiredFrameSchema = z
  .object({ type: z.literal("room.expired"), roomId: base64UrlSchema })
  .strict();
export type RemoteControlRoomExpiredFrame = z.infer<typeof remoteControlRoomExpiredFrameSchema>;

/** Worker → 桌面:桥已建立;resumed=true 表示手机凭设备凭据重连,无需二次确认(§2.3/§3.3)。 */
export const remoteControlBridgeOpenFrameSchema = z
  .object({
    type: z.literal("bridge.open"),
    proto: z.literal(REMOTE_CONTROL_PROTO_VERSION),
    deviceId: nonEmptyStringSchema,
    resumed: z.boolean(),
  })
  .strict();
export type RemoteControlBridgeOpenFrame = z.infer<typeof remoteControlBridgeOpenFrameSchema>;

/** Worker → 桌面:手机重连宽限耗尽,桥已断开,桌面应执行 DetachServicePort(§3.3)。 */
export const remoteControlBridgeDetachedFrameSchema = z
  .object({ type: z.literal("bridge.detached"), deviceId: nonEmptyStringSchema })
  .strict();
export type RemoteControlBridgeDetachedFrame = z.infer<
  typeof remoteControlBridgeDetachedFrameSchema
>;

/** Worker → 桌面:手机数据套接字断开,60s 宽限内保持 attachment 不 detach(§3.3)。 */
export const remoteControlPeerDisconnectedFrameSchema = z
  .object({
    type: z.literal("peer.disconnected"),
    deviceId: nonEmptyStringSchema,
    side: z.literal("client"),
  })
  .strict();
export type RemoteControlPeerDisconnectedFrame = z.infer<
  typeof remoteControlPeerDisconnectedFrameSchema
>;

/** Worker → 任一端:控制帧级错误(非 close code 通道)(§2.2)。 */
export const remoteControlErrorFrameSchema = z
  .object({ type: z.literal("error"), code: z.string(), message: z.string() })
  .strict();
export type RemoteControlErrorFrame = z.infer<typeof remoteControlErrorFrameSchema>;

/** host socket 上桌面可能收到的全部 TEXT 控制帧。 */
export const remoteControlHostSocketFrameSchema = z.discriminatedUnion("type", [
  remoteControlRoomReadyFrameSchema,
  remoteControlPairingRequestedFrameSchema,
  remoteControlPairingAcceptedFrameSchema,
  remoteControlRoomInvalidatedFrameSchema,
  remoteControlRoomExpiredFrameSchema,
  remoteControlBridgeOpenFrameSchema,
  remoteControlBridgeDetachedFrameSchema,
  remoteControlPeerDisconnectedFrameSchema,
  remoteControlPongFrameSchema,
  remoteControlErrorFrameSchema,
]);
export type RemoteControlHostSocketFrame = z.infer<typeof remoteControlHostSocketFrameSchema>;

// ============================================================================
// 配对链接 URL —— https://<worker域名>/p/<roomId>#c=<capability>(PROTOCOL.md §5)
// ============================================================================

/** 生成配对深链;capability 只进 URL fragment,不进任何服务器日志(§5)。 */
export function buildRemotePairingUrl(params: {
  workerBaseUrl: string;
  roomId: string;
  capability: string;
}): string {
  const base = params.workerBaseUrl.replace(/\/+$/g, "");
  return `${base}/p/${encodeURIComponent(params.roomId)}#${REMOTE_CONTROL_PAIRING_FRAGMENT_KEY}=${encodeURIComponent(params.capability)}`;
}

/** 解析 location.hash 中的 capability;缺失或键名不符时返回 null(§5 解析器规则)。 */
export function parseRemotePairingCapabilityFragment(hash: string): string | null {
  const value = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!value) return null;
  for (const segment of value.split("&")) {
    const separator = segment.indexOf("=");
    if (separator <= 0) continue;
    if (segment.slice(0, separator) !== REMOTE_CONTROL_PAIRING_FRAGMENT_KEY) continue;
    const capability = decodeURIComponent(segment.slice(separator + 1)).trim();
    return capability.length > 0 ? capability : null;
  }
  return null;
}

const localhostHostPattern = /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/;

/**
 * 规范化 Worker 域名:仅接受 https,或 localhost/127.0.0.1/::1 的 http(本地 wrangler dev)。
 * 接入 Key 是长期凭据,不允许经明文 http 发往公网(§4.1 传输约束)。
 */
export function normalizeRemoteControlWorkerBaseUrl(rawUrl: string): string | null {
  const trimmed = rawUrl.trim().replace(/\/+$/g, "");
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.pathname && parsed.pathname !== "/") return null;
  if (parsed.protocol === "https:") return parsed.origin;
  if (parsed.protocol === "http:" && localhostHostPattern.test(parsed.hostname)) {
    return parsed.origin;
  }
  return null;
}

/** 官方托管服务采用每房间 host token + Worker 限速，不使用可提取的客户端共享密钥。 */
export function isDefaultRemoteControlWorkerBaseUrl(rawUrl: string): boolean {
  return normalizeRemoteControlWorkerBaseUrl(rawUrl) === DEFAULT_REMOTE_CONTROL_WORKER_BASE_URL;
}

// ============================================================================
// 桌面内部 IPC 契约 —— Renderer ↔ Main(PROTOCOL.md §6.3)
// ============================================================================

/** 手机镜像目标:由 Renderer(业务状态所有者)在开启配对时提供给 Main 做 attachment 调度。
 * windowId 是 Main 权威字段:RemotePairingStart handler 会用可信 IPC sender 的宿主窗口
 * (BrowserWindow.fromWebContents(event.sender).id)覆盖该值,Renderer 传值仅占位、不参与
 * 路由;防伪造窗口路由由 handler 单点保证(与 platform.ts tab shell 的 windowId 边界同源)。
 * kind="remote":镜像既有 remote logical session(SSH/WSL/Docker),需三元组全等校验;
 * kind="local":镜像窗口当前本地工作区,以 scope:{kind:"local"} 第二 attachment 挂到窗口
 * Host(注册表按 attachmentId 键控,与 Renderer attachment 共存不互斥)。 */
export const remotePairingMirrorTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("remote"),
      windowId: z.number().int().positive(),
      remoteSessionId: nonEmptyStringSchema,
      workspacePath: nonEmptyStringSchema,
      workspaceIdentity: nonEmptyStringSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("local"),
      windowId: z.number().int().positive(),
      workspacePath: nonEmptyStringSchema,
      workspaceIdentity: nonEmptyStringSchema,
    })
    .strict(),
]);
export type RemotePairingMirrorTarget = z.infer<typeof remotePairingMirrorTargetSchema>;

export const remotePairingStartRequestSchema = z
  .object({ target: remotePairingMirrorTargetSchema.optional() })
  .strict();
export type RemotePairingStartRequest = z.infer<typeof remotePairingStartRequestSchema>;

export const remotePairingStartResultSchema = z.discriminatedUnion("success", [
  z
    .object({
      success: z.literal(true),
      roomId: nonEmptyStringSchema,
      pairingUrl: nonEmptyStringSchema,
      expiresAt: z.number().int().positive(),
    })
    .strict(),
  z.object({ success: z.literal(false), error: nonEmptyStringSchema }).strict(),
]);
export type RemotePairingStartResult = z.infer<typeof remotePairingStartResultSchema>;

export const remotePairingDecideRequestSchema = z
  .object({ requestId: nonEmptyStringSchema, accept: z.boolean() })
  .strict();
export type RemotePairingDecideRequest = z.infer<typeof remotePairingDecideRequestSchema>;

/** 配对面板状态唯一来源;Renderer 不自行推断(PROTOCOL.md §6.3)。 */
export const remotePairingStatePushSchema = z
  .object({
    state: z.enum(["waiting", "pairing", "bridged", "reconnecting", "stopped", "error"]),
    roomId: nonEmptyStringSchema.optional(),
    expiresAt: z.number().int().positive().nullable().optional(),
    pendingDevice: z
      .object({
        requestId: nonEmptyStringSchema,
        deviceName: z.string(),
        ua: z.string(),
      })
      .strict()
      .optional(),
    error: z.string().optional(),
  })
  .strict();
export type RemotePairingStatePush = z.infer<typeof remotePairingStatePushSchema>;

/** 已授权设备列表条目;凭据本身不落桌面,只有哈希与元数据(§4.3)。 */
export const remoteControlDeviceSchema = z
  .object({
    deviceId: nonEmptyStringSchema,
    deviceName: z.string(),
    grantedAt: z.number().int().positive(),
    lastSeenAt: z.number().int().positive(),
  })
  .strict();
export type RemoteControlDevice = z.infer<typeof remoteControlDeviceSchema>;

/** 跨房间免二次确认重连所需的持久化形态(含 credHash;§4.3.2)。 */
export const remoteControlPersistedDeviceSchema = remoteControlDeviceSchema.extend({
  credHash: base64UrlSchema,
});
export type RemoteControlPersistedDevice = z.infer<typeof remoteControlPersistedDeviceSchema>;

export const remoteDevicesRefreshResultSchema = z
  .object({ devices: z.array(remoteControlDeviceSchema).max(REMOTE_CONTROL_MAX_PERSISTED_DEVICES) })
  .strict();
export type RemoteDevicesRefreshResult = z.infer<typeof remoteDevicesRefreshResultSchema>;

export const remoteDeviceRevokeRequestSchema = z
  .object({ deviceId: nonEmptyStringSchema })
  .strict();
export type RemoteDeviceRevokeRequest = z.infer<typeof remoteDeviceRevokeRequestSchema>;

/**
 * 远程控制配置;Main 是 owner,Renderer 只经 IPC 读写。
 * 接入 Key 只回 hasAccessKey,永不回明文(PROTOCOL.md §6.3)。
 */
export const remoteControlConfigSchema = z
  .object({
    enabled: z.boolean(),
    workerBaseUrl: z.string(),
    hasAccessKey: z.boolean(),
    pairingTtlMs: z.number().int().positive(),
    allowNewDevices: z.boolean(),
    /** 空闲自动断开(桌面本地策略,§3.4);0 = 关闭。 */
    idleDisconnectMs: z.number().int().nonnegative(),
  })
  .strict();
export type RemoteControlConfig = z.infer<typeof remoteControlConfigSchema>;

/** config-get 响应:配置 + 配对状态快照。Renderer 挂载/重挂载时一次取全,
 * 弥补推送通道"仅在状态变化时广播"导致的状态未知(评审 high:重挂载误判"未在等待",
 * 可能误触发 stopPairing 断开正在镜像的会话)。pairingUrl 仅在 waiting 态返回
 * (capability 未消费,可恢复二维码);其余状态已 consume-once,置空(§2.2)。 */
export const remoteControlConfigSnapshotSchema = remoteControlConfigSchema.extend({
  pairing: remotePairingStatePushSchema.nullable(),
  pairingUrl: nonEmptyStringSchema.nullable(),
});
export type RemoteControlConfigSnapshot = z.infer<typeof remoteControlConfigSnapshotSchema>;

/** accessKey 为 write-only:写入凭据集中存储,不落明文配置、不进日志、不回读(§6.3)。
 * 下限 32 字符对齐 §4.1 "≥32 字节熵" 的接入 Key 强度约定。 */
export const remoteControlConfigSetRequestSchema = z
  .object({
    enabled: z.boolean().optional(),
    workerBaseUrl: z.string().optional(),
    accessKey: z.string().min(32).max(256).optional(),
    pairingTtlMs: z.number().int().positive().optional(),
    allowNewDevices: z.boolean().optional(),
    idleDisconnectMs: z.number().int().nonnegative().optional(),
  })
  .strict();
export type RemoteControlConfigSetRequest = z.infer<typeof remoteControlConfigSetRequestSchema>;

export const remoteControlConfigSetResultSchema = z
  .object({ success: z.boolean(), error: z.string().optional() })
  .strict();
export type RemoteControlConfigSetResult = z.infer<typeof remoteControlConfigSetResultSchema>;

/** 测试连接结果:Main 持接入 Key 调 Worker `POST /api/health`(§1);错误码 fail-closed 语义:
 * AUTH_REJECTED=401(Key 不对或 Worker 侧 secret 未配置),NETWORK:*=网络不可达。 */
export const remoteControlTestResultSchema = z
  .object({
    success: z.boolean(),
    error: z.string().optional(),
    latencyMs: z.number().int().nonnegative().optional(),
  })
  .strict();
export type RemoteControlTestResult = z.infer<typeof remoteControlTestResultSchema>;
