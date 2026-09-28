import { useEffect, useState, type ReactNode } from "react";
import type { PairingDeepLinkRoute } from "./pairingDeepLink.js";
import {
  clearStoredPairingCredential,
  loadStoredPairingCredential,
  saveStoredPairingCredential,
} from "./pairingCredentialStore.js";
import type { PairingFailureKey } from "./pairingFrames.js";
import {
  DATA_SOCKET_RETRY_DEADLINE_MS,
  DATA_SOCKET_RETRY_DELAY_MS,
  DATA_SOCKET_RETRY_KEYS,
  scheduleMirrorReconnectReload,
} from "./mirrorReconnect.js";
import {
  buildDataSocketUrl,
  buildPairingSocketUrl,
  connectBridgedDataSocket,
  MobileBridgeError,
  openPairingSocket,
  type MobileDataServices,
  type PairingSocketOutcome,
} from "./pairingSockets.js";

type PairingPhase =
  | { kind: "connecting" }
  | { kind: "waiting-confirm" }
  | { kind: "bridging" }
  | { kind: "failed"; key: PairingFailureKey; detail?: string };

// 设备凭据本身已不可恢复的失败(吊销/鉴权失效):清掉本地凭据,避免后续用死凭据
// 重连白白消耗 Worker 的失败计数(§3.1 连续失败达阈值房间作废)。
// room-missing(4004)/expired(4005) 是房间级死亡,不是凭据死亡:桌面每次 room.create
// 都按持久化列表重注册设备(§4.3.2,worker room.ts mergeDevices),凭据对新房间仍有效,
// 清掉会迫使用户在桌面重启/新房间后重新扫码+人工确认。
const CREDENTIAL_DEATH_KEYS: ReadonlySet<PairingFailureKey> = new Set([
  "auth",
  "invalidated",
  "stopped",
]);

// 链路瞬时故障:capability 未被 Worker 消费或凭据仍有效时,整页刷新可重试;
// busy 也归入可重试——旧桥槽由 Worker 心跳回收后,同凭据重连即可成功。
const RETRYABLE_KEYS: ReadonlySet<PairingFailureKey> = new Set([
  "network",
  "timeout",
  "heartbeat",
  "bridge-timeout",
  "busy",
]);

// 配对页位于 LCodeIntlProvider 之外(services 尚未建立),与 main.tsx 的
// WebBootstrapErrorScreen 一致用 navigator.language 分流中英文;zh-* 一律落 zh-CN
// 与 packages/ui IntlProvider 的既有判定一致(IntlProvider.tsx:167)。
// 授权完成进入 app shell 后由既有 i18n 体系接管。
const PAIRING_COPY = {
  "zh-CN": {
    documentTitle: "LCode 远程配对",
    connecting: "正在连接配对通道…",
    waitingTitle: "等待桌面确认",
    waitingHint: "请在桌面端「远程控制」面板选择“允许此设备”。",
    bridgingTitle: "双方授权完成,正在接入工作区…",
    failedTitle: "配对失败",
    staleLinkHint: "请在桌面端重新生成配对链接(扫码或复制链接)后再试。",
    retryHint: "可点击重试;若仍失败,请在桌面端重新生成配对链接。",
    retry: "重试",
  },
  "en-US": {
    documentTitle: "LCode Remote Pairing",
    connecting: "Connecting to the pairing channel…",
    waitingTitle: "Waiting for desktop confirmation",
    waitingHint: "Choose “Allow this device” in the desktop Remote Control panel.",
    bridgingTitle: "Authorized. Connecting to your workspace…",
    failedTitle: "Pairing failed",
    staleLinkHint: "Generate a new pairing link (QR code or copied URL) on the desktop and try again.",
    retryHint: "You can retry; if it keeps failing, generate a new pairing link on the desktop.",
    retry: "Retry",
  },
} as const;

type PairingLocale = keyof typeof PAIRING_COPY;

const FAILURE_COPY: Record<PairingFailureKey, Record<PairingLocale, string>> = {
  network: { "zh-CN": "网络连接失败。", "en-US": "Network connection failed." },
  timeout: { "zh-CN": "等待超时。", "en-US": "Timed out while waiting." },
  auth: {
    "zh-CN": "配对凭据无效、已被使用或已过期。",
    "en-US": "The pairing credential is invalid, already used, or expired.",
  },
  protocol: { "zh-CN": "连接出现协议违规。", "en-US": "A protocol violation occurred." },
  "room-missing": {
    "zh-CN": "配对房间不存在,链接可能已失效。",
    "en-US": "The pairing room does not exist; the link may be stale.",
  },
  expired: { "zh-CN": "配对链接已过期。", "en-US": "The pairing link has expired." },
  invalidated: {
    "zh-CN": "多次配对失败,房间已作废。",
    "en-US": "Too many failed attempts; the room was invalidated.",
  },
  stopped: {
    "zh-CN": "桌面已停止远程控制,或此设备已被吊销。",
    "en-US": "Remote control was stopped on the desktop, or this device was revoked.",
  },
  busy: {
    "zh-CN": "该房间已有其他设备接入。",
    "en-US": "Another device is already connected to this room.",
  },
  heartbeat: { "zh-CN": "连接心跳超时。", "en-US": "The connection heartbeat timed out." },
  "bridge-timeout": {
    "zh-CN": "建立数据通道超时。",
    "en-US": "Timed out while establishing the data bridge.",
  },
  "invalid-link": {
    "zh-CN": "配对链接缺少有效凭据。",
    "en-US": "This pairing link is missing a valid credential.",
  },
  rejected: { "zh-CN": "桌面端拒绝了本次配对。", "en-US": "The desktop rejected this pairing." },
  "worker-error": {
    "zh-CN": "配对服务返回错误。",
    "en-US": "The pairing service returned an error.",
  },
};

function resolvePairingLocale(): PairingLocale {
  return /^zh\b/i.test(navigator.language) ? "zh-CN" : "en-US";
}

function outcomeToFailureKey(outcome: Exclude<PairingSocketOutcome, { kind: "accepted" }>): PairingFailureKey {
  switch (outcome.kind) {
    case "rejected":
      return "rejected";
    case "worker-error":
      return "worker-error";
    case "failed":
      return outcome.key;
  }
}

export function MobilePairingPage({
  route,
  onConnected,
}: {
  route: PairingDeepLinkRoute;
  onConnected: (services: MobileDataServices) => void;
}) {
  const [phase, setPhase] = useState<PairingPhase>({ kind: "connecting" });
  const locale = resolvePairingLocale();
  const copy = PAIRING_COPY[locale];

  useEffect(() => {
    document.title = copy.documentTitle;
    // 与 share 页先例一致(main.tsx:129-131):无障碍与浏览器翻译依赖文档语言声明。
    document.documentElement.lang = locale;
  }, [copy.documentTitle, locale]);

  useEffect(() => {
    let disposed = false;

    const connectDataSocketOnce = async (
      roomId: string,
      deviceCredential: string,
    ): Promise<{ ok: true } | { ok: false; key: PairingFailureKey }> => {
      setPhase({ kind: "bridging" });
      try {
        const services = await connectBridgedDataSocket(
          buildDataSocketUrl(roomId, deviceCredential),
          // 接管后断链:网络类死亡在 Worker 宽限窗口内自动刷新重连(§3.3),
          // 刷新后回到本页凭会话凭据走 resumed 重连,bridging 界面即重连提示
          scheduleMirrorReconnectReload,
        );
        if (!disposed) {
          onConnected(services);
        }
        return { ok: true };
      } catch (error) {
        return { ok: false, key: error instanceof MobileBridgeError ? error.key : "network" };
      }
    };

    const connectDataSocket = async (
      roomId: string,
      deviceCredential: string,
    ): Promise<{ ok: true } | { ok: false; key: PairingFailureKey }> => {
      // 4008 busy:旧套接字无 FIN 死亡时,Worker 需等约 75s 心跳回收才释放桥槽
      // (room.ts:795-811),且 busy 不计失败(room.ts:289-295)——在截止时间内
      // 对 busy/网络类失败有界重试,避免移动端闪断直接落到终态失败页。
      const deadline = Date.now() + DATA_SOCKET_RETRY_DEADLINE_MS;
      for (;;) {
        const result = await connectDataSocketOnce(roomId, deviceCredential);
        if (disposed || result.ok || !DATA_SOCKET_RETRY_KEYS.has(result.key)) {
          return result;
        }
        if (deadline - Date.now() <= DATA_SOCKET_RETRY_DELAY_MS) {
          return result;
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, DATA_SOCKET_RETRY_DELAY_MS));
        if (disposed) {
          return result;
        }
      }
    };

    const run = async (): Promise<void> => {
      // 凭据来源优先级(契约 §4.3.2/§3.3):设备凭据跨房间有效——桌面每次 room.create
      // 都按持久化设备表重注册(worker room.ts mergeDevices),因此即使深链指向新房间,
      // 也先凭已存凭据尝试免二次确认重连;失败再回退深链 capability 走完整双方授权;
      // 两者皆无则按 §5 显示配对失败。
      const stored = loadStoredPairingCredential();
      const routeRoomId = route.roomId;

      if (stored && routeRoomId !== null) {
        const result = await connectDataSocket(routeRoomId, stored.deviceCredential);
        if (disposed || result.ok) {
          return;
        }
        if (CREDENTIAL_DEATH_KEYS.has(result.key)) {
          // 凭据本身已死(吊销/鉴权失效):清掉本地凭据
          clearStoredPairingCredential();
        }
        if (route.capability === null) {
          // 无新 capability 可回退:房间级死亡(4004/4005)或瞬时故障下凭据可能仍有效,保留不清
          setPhase({ kind: "failed", key: result.key });
          return;
        }
        // 深链还带未消费的 capability:回退完整双方授权
      }

      if (routeRoomId === null || route.capability === null) {
        setPhase({ kind: "failed", key: "invalid-link" });
        return;
      }

      setPhase({ kind: "connecting" });
      const outcome = await openPairingSocket(buildPairingSocketUrl(routeRoomId, route.capability), () => {
        if (!disposed) {
          setPhase({ kind: "waiting-confirm" });
        }
      });
      if (disposed) {
        return;
      }
      if (outcome.kind !== "accepted") {
        setPhase({
          kind: "failed",
          key: outcomeToFailureKey(outcome),
          detail:
            outcome.kind === "rejected"
              ? outcome.reason
              : outcome.kind === "worker-error"
                ? outcome.message
                : undefined,
        });
        return;
      }

      // accepted 的凭据明文只出现这一次:先落会话存储再建数据通道,断链后可凭凭据重连
      saveStoredPairingCredential({
        roomId: routeRoomId,
        deviceId: outcome.deviceId,
        deviceCredential: outcome.deviceCredential,
        grantedAt: Date.now(),
      });
      const result = await connectDataSocket(routeRoomId, outcome.deviceCredential);
      if (!disposed && !result.ok) {
        if (CREDENTIAL_DEATH_KEYS.has(result.key)) {
          clearStoredPairingCredential();
        }
        setPhase({ kind: "failed", key: result.key });
      }
    };

    void run().catch((error: unknown) => {
      // run 内部已把可预期失败映射为 phase;这里只兜真正未预期的异常
      if (!disposed) {
        setPhase({
          kind: "failed",
          key: "network",
          detail: error instanceof Error ? error.message : undefined,
        });
      }
    });

    return () => {
      disposed = true;
    };
  }, [route, onConnected]);

  if (phase.kind === "failed") {
    return (
      <PairingShell>
        <div className="flex items-center gap-3">
          <span className="size-2 rounded-full bg-destructive" />
          <h1 className="text-ui-xs font-medium">{copy.failedTitle}</h1>
        </div>
        <p className="mt-2 text-ui-xs/relaxed break-all text-foreground-subtle">
          {FAILURE_COPY[phase.key][locale]}
          {phase.detail ? ` ${phase.detail}` : ""}
        </p>
        <p className="mt-2 text-ui-xs/relaxed text-foreground-subtle">
          {RETRYABLE_KEYS.has(phase.key) ? copy.retryHint : copy.staleLinkHint}
        </p>
        {RETRYABLE_KEYS.has(phase.key) ? (
          <button
            type="button"
            className="mt-4 rounded-lg border border-border bg-surface px-3 py-2 text-ui-xs text-foreground-subtle hover:bg-surface-hover"
            onClick={() => window.location.reload()}
          >
            {copy.retry}
          </button>
        ) : null}
      </PairingShell>
    );
  }

  const statusText =
    phase.kind === "connecting"
      ? copy.connecting
      : phase.kind === "waiting-confirm"
        ? copy.waitingTitle
        : copy.bridgingTitle;

  return (
    <PairingShell>
      <div className="flex items-center gap-3">
        <span className="size-2 animate-pulse rounded-full bg-primary" />
        <h1 className="text-ui-xs font-medium">{statusText}</h1>
      </div>
      {phase.kind === "waiting-confirm" ? (
        <p className="mt-2 text-ui-xs/relaxed text-foreground-subtle">{copy.waitingHint}</p>
      ) : null}
    </PairingShell>
  );
}

function PairingShell({ children }: { children: ReactNode }) {
  return (
    <div className="h-dvh min-h-dvh w-screen bg-background text-foreground">
      <div className="mx-auto flex h-full w-full max-w-lg items-center px-4">
        <section className="w-full rounded-xl border border-card-border bg-card p-5">{children}</section>
      </div>
    </div>
  );
}
