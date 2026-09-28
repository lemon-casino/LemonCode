// 远程控制（手机镜像桌面）Renderer 侧能力面。
//
// 协议类型的事实源是 packages/shared/src/remoteControl.ts（镜像 cfworker-remote/PROTOCOL.md
// §6.3），本文件只做两件事：把它们收敛成一个窄接口（consumer-side contract），并从平台
// 服务上按可选方法探测能力。桌面 preload/desktopPlatform 实现 IPlatformService 上这批
// 可选方法后，resolveRemoteControlBridge 才返回非空；Web/旧版 preload 缺能力时保持
// null，UI 据此显示「仅桌面端可用」，不在设置页里直接触碰 window.lcode。
//
// 契约外的「测试连接」（Main 持接入 Key 调 Worker `POST /api/health`，PROTOCOL.md §1）
// 在 shared 通道表里没有对应项，这里保留为可选能力 testRemoteControlConnection：
// 平台未提供时 UI 禁用该按钮，不自行绕过 Main 直连 Worker。
import type {
  IPlatformService,
  RemoteControlConfigSetRequest,
  RemoteControlConfigSetResult,
  RemoteControlConfigSnapshot,
  RemoteControlTestResult,
  RemoteControlDevice,
  RemoteDevicesRefreshResult,
  RemotePairingDecideRequest,
  RemotePairingStartRequest,
  RemotePairingStartResult,
  RemotePairingStatePush,
} from "@lcode/shared";

export type {
  RemoteControlConfigSnapshot,
  RemoteControlConfigSnapshot as RemoteControlConfig,
  RemoteControlConfigSetRequest,
  RemoteControlConfigSetResult,
  RemoteControlDevice,
  RemoteDevicesRefreshResult,
  RemotePairingDecideRequest,
  RemotePairingStartRequest,
  RemotePairingStartResult,
  RemotePairingStatePush,
} from "@lcode/shared";

/** 等待桌面用户裁决的设备（PROTOCOL.md §2.2 pairing.requested）。 */
export type RemotePairingPendingDevice = NonNullable<RemotePairingStatePush["pendingDevice"]>;

/** 配对面板状态（PROTOCOL.md §6.3 lcode:remote-pairing-state 推送；Renderer 不自行推断）。 */
export type RemotePairingStateEvent = RemotePairingStatePush;

/** 面板状态枚举（waiting/pairing/bridged/stopped/error）。 */
export type RemotePairingPhase = RemotePairingStatePush["state"];

/** 配置写入补丁 = shared 的 set 请求（accessKey 为 write-only，永不回读）。 */
export type RemoteControlConfigPatch = RemoteControlConfigSetRequest;

/** 「测试连接」结果:Main 持接入 Key 调 Worker `POST /api/health`(§1),形状以 shared 为准。 */
export type { RemoteControlTestResult } from "@lcode/shared";

/**
 * 远程控制平台能力面。除 testRemoteControlConnection 外全部必需：
 * resolveRemoteControlBridge 只有在 8 个契约通道能力齐备时才返回非空，
 避免「配对可用但设备列表按钮静默失效」的半能力状态。
 */
export interface RemoteControlPlatformBridge {
  startRemotePairing(request?: RemotePairingStartRequest): Promise<RemotePairingStartResult>;
  stopRemotePairing(): Promise<void>;
  decideRemotePairing(request: RemotePairingDecideRequest): Promise<void>;
  /**
   * 订阅配对状态推送，返回 disposer。Main 是状态唯一所有者，但**仅在状态变化时推送**；
   * 重挂载后的初始状态请从 getRemoteControlConfig 返回的 pairing/pairingUrl 快照恢复
   * （§6.3），不要把「未收到推送」当作「未在等待」。
   */
  onRemotePairingState(handler: (state: RemotePairingStatePush) => void): () => void;
  listRemoteDevices(): Promise<RemoteDevicesRefreshResult>;
  revokeRemoteDevice(deviceId: string): Promise<void>;
  /** 配置 + 配对状态快照：挂载/保存后调用，pairing 为 Main 最近一次推送(null=无进行中配对)。 */
  getRemoteControlConfig(): Promise<RemoteControlConfigSnapshot>;
  setRemoteControlConfig(request: RemoteControlConfigSetRequest): Promise<RemoteControlConfigSetResult>;
  /** 可选：由 Main 持接入 Key 调 Worker `POST /api/health`（PROTOCOL.md §1），Renderer 无法自行测试。 */
  testRemoteControlConnection?(): Promise<RemoteControlTestResult>;
}

/**
 * target.windowId 的 Renderer 占位值。
 *
 * 真实窗口 id 是可信路由事实,Renderer 拿不到也不该拿(platform.ts:80 的既有边界:
 * "windowId 必须由 main 绑定可信 IPC sender")。Main 的 RemotePairingStart handler
 * 会用 BrowserWindow.fromWebContents(event.sender).id 权威覆盖该字段——Renderer 传值
 * 仅用于满足 shared 的 strict schema,不参与 attachment 路由;编造真实窗口 id 反而会
 * 命中 REMOTE_SESSION_WINDOW_MISMATCH fail-closed。
 */
export const REMOTE_PAIRING_PLACEHOLDER_WINDOW_ID = 1;

/** 由激活 workspace 上下文组装的镜像目标;三元组来自 tabStore 的激活 workspace tab。 */
export function buildRemotePairingMirrorTarget(params: {
  remoteSessionId?: string | null;
  workspacePath?: string | null;
  workspaceIdentity?: string | null;
}): NonNullable<RemotePairingStartRequest["target"]> | null {
  const remoteSessionId = params.remoteSessionId?.trim();
  const workspacePath = params.workspacePath?.trim();
  if (!workspacePath) {
    // 没有工作区路径就组装不出镜像目标;调用方保持 target 缺省,面板禁用「开启等待」。
    return null;
  }
  // 身份 key 统一规则:workspaceIdentity?.trim() || workspacePath(AGENTS.md Workspace Identity)。
  const workspaceIdentity = params.workspaceIdentity?.trim() || workspacePath;
  if (remoteSessionId) {
    // 远程工作区(SSH/WSL/Docker):走既有 remote 入口,三元组全等校验(PROTOCOL.md §6.2)。
    return {
      kind: "remote",
      workspacePath,
      workspaceIdentity,
      remoteSessionId,
      windowId: REMOTE_PAIRING_PLACEHOLDER_WINDOW_ID,
    };
  }
  // 本地工作区:scope:{kind:"local"} 第二 attachment 挂到窗口 Host,与 Renderer 共存
  // (注册表按 attachmentId 键控);手机拿到与 Renderer 相同的服务面 = 镜像语义。
  return {
    kind: "local",
    workspacePath,
    workspaceIdentity,
    windowId: REMOTE_PAIRING_PLACEHOLDER_WINDOW_ID,
  };
}

function isFunction(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === "function";
}

/**
 * 从平台服务上按可选方法探测远程控制能力（与 importChromeBrowserData 等可选能力的
 * feature-detect 模式一致）。任一必需能力缺失即整体判不支持，fail-closed。
 */
export function resolveRemoteControlBridge(
  platform: IPlatformService | null | undefined,
): RemoteControlPlatformBridge | null {
  const candidates = platform as Partial<RemoteControlPlatformBridge> | null | undefined;
  if (!candidates) return null;
  const required = [
    "startRemotePairing",
    "stopRemotePairing",
    "decideRemotePairing",
    "onRemotePairingState",
    "listRemoteDevices",
    "revokeRemoteDevice",
    "getRemoteControlConfig",
    "setRemoteControlConfig",
  ] as const;
  for (const method of required) {
    if (!isFunction(candidates[method])) return null;
  }
  return candidates as RemoteControlPlatformBridge;
}
