// 配对面板：等待手机连接 / 设备裁决 / 已就绪 / 停止 / 刷新二维码 / 复制链接。
// 面板状态唯一来源是 Desktop Main 的 lcode:remote-pairing-state 推送（hook 缓存），
// 本组件只做投影：不在本地推断状态迁移，也不持有第二个房间状态副本。
// pairingUrl 只在内存中存在（capability 只经 URL fragment 传递，PROTOCOL.md §5）。
import { useCallback, useState } from "react";
import { LoaderCircle } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog.js";
import type { RemotePairingStateEvent } from "@/settings/remoteControlBridge.js";
import { RemotePairingQrCode } from "@/settings/RemotePairingQrCode.js";
import { formatDateTime } from "@/settings/automationFormat.js";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { StatusDot } from "@/settings/StatusDot.js";

interface RemotePairingPanelProps {
  /** 组装不出镜像 target(激活的不是远程 workspace)时为 false:开启/刷新入口禁用并给提示。 */
  canStart: boolean;
  noMirrorTargetHint: string;
  pairing: RemotePairingStateEvent | null;
  pairingUrl: string | null;
  startingPairing: boolean;
  stoppingPairing: boolean;
  onStart: () => Promise<void>;
  onStop: () => Promise<void>;
  onDecide: (requestId: string, accept: boolean) => Promise<void>;
}

type PairingDotTone = "green" | "amber" | "red" | "subtle";

/** 面板展示状态。pairing 为 null（从未收到推送）与 stopped（房间终态）语义不同：
 * 前者是「状态未知」——Main 仅在状态变化时推送、契约 §6.3 无状态查询通道，
 * 设置页重挂载后无法区分「没在配对」与「正在镜像中」，必须如实降级并由二次确认拦截。 */
function resolvePanelPhase(pairing: RemotePairingStateEvent | null): {
  state: "unknown" | "idle" | "waiting" | "pairing" | "bridged" | "error";
  tone: PairingDotTone;
} {
  if (!pairing) return { state: "unknown", tone: "subtle" };
  if (pairing.state === "stopped") return { state: "idle", tone: "subtle" };
  if (pairing.state === "bridged") return { state: "bridged", tone: "green" };
  if (pairing.state === "error") return { state: "error", tone: "red" };
  return { state: pairing.state, tone: "amber" };
}

/**
 * Main 推送的 error 机器码(desktopRemoteControlController pushState 的全集)到本地化文案的
 * 映射;未收录的码走 error.unknown 包裹原样展示,保证新增码不静默丢失信息。
 */
const REMOTE_PAIRING_ERROR_MESSAGE_IDS: Record<string, string> = {
  ROOM_INVALIDATED: "settings.remoteControl.pairing.error.roomInvalidated",
  ACCESS_KEY_REJECTED: "settings.remoteControl.pairing.error.accessKeyRejected",
  MIRROR_TARGET_MISSING: "settings.remoteControl.pairing.error.mirrorTargetMissing",
  FRAME_PROTOCOL_VIOLATION: "settings.remoteControl.pairing.error.frameProtocolViolation",
  REMOTE_SESSION_MISSING: "settings.remoteControl.pairing.error.remoteSessionMissing",
  REMOTE_SESSION_OFFLINE: "settings.remoteControl.pairing.error.remoteSessionOffline",
  REMOTE_SESSION_WINDOW_MISMATCH:
    "settings.remoteControl.pairing.error.remoteSessionWindowMismatch",
  REMOTE_WORKSPACE_IDENTITY_MISMATCH:
    "settings.remoteControl.pairing.error.remoteWorkspaceIdentityMismatch",
  ATTACH_FAILED: "settings.remoteControl.pairing.error.attachFailed",
  ROOM_REGENERATION_FAILED: "settings.remoteControl.pairing.error.roomRegenerationFailed",
  WORKER_BASE_URL_INVALID: "settings.remoteControl.pairing.error.workerBaseUrlInvalid",
  ACCESS_KEY_MISSING: "settings.remoteControl.pairing.error.accessKeyMissing",
};

function describeRemotePairingError(
  code: string,
  intl: ReturnType<typeof useLCodeIntl>["intl"],
): string {
  const messageId = REMOTE_PAIRING_ERROR_MESSAGE_IDS[code];
  if (messageId) {
    return intl.formatMessage({ id: messageId });
  }
  return intl.formatMessage({ id: "settings.remoteControl.pairing.error.unknown" }, { code });
}

export function RemotePairingPanel({
  canStart,
  noMirrorTargetHint,
  pairing,
  pairingUrl,
  startingPairing,
  stoppingPairing,
  onStart,
  onStop,
  onDecide,
}: RemotePairingPanelProps) {
  const { intl } = useLCodeIntl();
  const [decidePending, setDecidePending] = useState(false);
  // 状态未知(pairing=null)时的「开启等待」会 stop 当前房间:若手机正镜像中会立即断开,
  // 必须二次确认后才执行(评审:用户重挂载设置页后无法区分两种状态,不能一键触发)。
  const [restartConfirmOpen, setRestartConfirmOpen] = useState(false);
  const phase = resolvePanelPhase(pairing);
  const busy = startingPairing || stoppingPairing || decidePending;

  const handleCopyLink = useCallback(async () => {
    if (!pairingUrl) return;
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      toast(intl.formatMessage({ id: "settings.remoteControl.pairing.copyFailed" }));
      return;
    }
    try {
      await navigator.clipboard.writeText(pairingUrl);
      toast(intl.formatMessage({ id: "settings.remoteControl.pairing.copiedToast" }));
    } catch {
      toast(intl.formatMessage({ id: "settings.remoteControl.pairing.copyFailed" }));
    }
  }, [intl, pairingUrl]);

  const handleDecide = useCallback(
    async (requestId: string, accept: boolean) => {
      setDecidePending(true);
      try {
        await onDecide(requestId, accept);
      } finally {
        setDecidePending(false);
      }
    },
    [onDecide],
  );

  const statusLabel = intl.formatMessage({
    id:
      phase.state === "idle"
        ? "settings.remoteControl.pairing.status.idle"
        : `settings.remoteControl.pairing.status.${phase.state}`,
  });
  const expiresAt = pairing?.expiresAt;
  const pendingDevice = pairing?.pendingDevice;

  return (
    // @container：等待态的二维码/操作布局按容器宽度断行（弹框 400px 走上下堆叠，
    // 设置页宽容器保持左右并排）。sm: 是视口断点，在桌面端弹框里永远不会命中，
    // 曾把右侧操作列压成一条窄竖条（用户反馈“太拥挤”）。
    <div className="space-y-3 @container" data-testid="remote-control-pairing-panel">
      <div className="flex items-center gap-2" data-testid="remote-control-pairing-status">
        <StatusDot tone={phase.tone} spinning={phase.state === "waiting" && !busy} />
        <span className="text-ui-base font-medium text-foreground">{statusLabel}</span>
        {expiresAt && (phase.state === "waiting" || phase.state === "pairing") ? (
          <span className="text-ui-base text-foreground-subtle">
            {intl.formatMessage(
              { id: "settings.remoteControl.pairing.expiresAt" },
              {
                time: formatDateTime(expiresAt),
              },
            )}
          </span>
        ) : null}
      </div>

      {phase.state === "unknown" ? (
        <div className="flex flex-col items-start gap-2">
          <p className="text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "settings.remoteControl.pairing.unknownDescription" })}
          </p>
          {!canStart ? (
            <p className="text-ui-base text-foreground-subtle">{noMirrorTargetHint}</p>
          ) : null}
          <Button
            type="button"
            size="lg"
            disabled={busy || !canStart}
            onClick={() => setRestartConfirmOpen(true)}
          >
            {startingPairing ? (
              <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
            ) : null}
            {intl.formatMessage({ id: "settings.remoteControl.pairing.start" })}
          </Button>
        </div>
      ) : null}

      {phase.state === "idle" ? (
        <div className="flex flex-col items-start gap-2">
          {!canStart ? (
            <p className="text-ui-base text-foreground-subtle">{noMirrorTargetHint}</p>
          ) : (
            <p className="text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "settings.remoteControl.pairing.idleDescription" })}
            </p>
          )}
          <Button
            type="button"
            size="lg"
            disabled={busy || !canStart}
            onClick={() => void onStart()}
          >
            {startingPairing ? (
              <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
            ) : null}
            {intl.formatMessage({ id: "settings.remoteControl.pairing.start" })}
          </Button>
        </div>
      ) : null}

      {phase.state === "waiting" ? (
        pairingUrl ? (
          // 列布局（窄容器/弹框）子项按默认 stretch 撑满行宽，提示文案与链接在容器内
          // 折行/截断；@lg 宽容器（设置页）恢复左右并排并顶部对齐。
          <div className="flex flex-col gap-3 @lg:flex-row @lg:items-start @lg:gap-5">
            <div className="self-center @lg:self-start">
              <RemotePairingQrCode url={pairingUrl} />
            </div>
            <div className="flex min-w-0 flex-1 flex-col items-start gap-2">
              <p className="text-ui-base text-foreground-subtle">
                {intl.formatMessage({ id: "settings.remoteControl.pairing.qrHint" })}
              </p>
              {/* 只展示截断的链接用于人工核对域名；完整链接走复制，避免在页面上被截取。 */}
              <code
                className="max-w-full truncate rounded bg-surface px-2 py-1 text-ui-xs font-mono text-foreground-subtle"
                data-testid="remote-control-pairing-url"
              >
                {pairingUrl}
              </code>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="lg"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void handleCopyLink()}
                >
                  {intl.formatMessage({ id: "settings.remoteControl.pairing.copyLink" })}
                </Button>
                <Button
                  type="button"
                  size="lg"
                  variant="outline"
                  disabled={busy || !canStart}
                  onClick={() => void onStart()}
                >
                  {startingPairing ? (
                    <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                  ) : null}
                  {intl.formatMessage({ id: "settings.remoteControl.pairing.refreshQr" })}
                </Button>
                <Button
                  type="button"
                  size="lg"
                  variant="destructive"
                  disabled={stoppingPairing}
                  onClick={() => void onStop()}
                >
                  {stoppingPairing ? (
                    <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                  ) : null}
                  {intl.formatMessage({ id: "settings.remoteControl.pairing.stop" })}
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-start gap-2">
            {/* waiting 但没有 pairingUrl：二维码已在配对阶段被消费或本窗口重新挂载后
                未拿到新 capability（契约 §4.2 consume-once），必须刷新才能继续配对。 */}
            <p className="text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "settings.remoteControl.pairing.staleHint" })}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="lg"
                disabled={busy || !canStart}
                onClick={() => void onStart()}
              >
                {startingPairing ? (
                  <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                ) : null}
                {intl.formatMessage({ id: "settings.remoteControl.pairing.refreshQr" })}
              </Button>
              <Button
                type="button"
                size="lg"
                variant="destructive"
                disabled={stoppingPairing}
                onClick={() => void onStop()}
              >
                {stoppingPairing ? (
                  <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                ) : null}
                {intl.formatMessage({ id: "settings.remoteControl.pairing.stop" })}
              </Button>
            </div>
          </div>
        )
      ) : null}

      {phase.state === "pairing" && pendingDevice ? (
        <div
          className="flex flex-col gap-3 rounded-lg border border-border bg-surface px-4 py-3"
          data-testid="remote-control-pairing-device-request"
        >
          <div className="min-w-0">
            <div className="text-ui-base font-medium text-foreground">
              {pendingDevice.deviceName?.trim() ||
                intl.formatMessage({ id: "settings.remoteControl.pairing.unknownDevice" })}
            </div>
            {pendingDevice.ua ? (
              <div className="mt-1 truncate text-ui-xs font-mono text-foreground-subtle">
                {pendingDevice.ua}
              </div>
            ) : null}
          </div>
          <p className="text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "settings.remoteControl.pairing.deviceRequestDescription" })}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="lg"
              disabled={busy}
              onClick={() => void handleDecide(pendingDevice.requestId, true)}
            >
              {decidePending ? (
                <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
              ) : null}
              {intl.formatMessage({ id: "settings.remoteControl.pairing.allow" })}
            </Button>
            <Button
              type="button"
              size="lg"
              variant="outline"
              disabled={busy}
              onClick={() => void handleDecide(pendingDevice.requestId, false)}
            >
              {intl.formatMessage({ id: "settings.remoteControl.pairing.reject" })}
            </Button>
          </div>
        </div>
      ) : null}

      {phase.state === "bridged" ? (
        <div className="flex flex-col items-start gap-2">
          <p className="text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "settings.remoteControl.pairing.bridgedDescription" })}
          </p>
          <Button
            type="button"
            size="lg"
            variant="destructive"
            disabled={stoppingPairing}
            onClick={() => void onStop()}
          >
            {stoppingPairing ? (
              <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
            ) : null}
            {intl.formatMessage({ id: "settings.remoteControl.pairing.stop" })}
          </Button>
        </div>
      ) : null}

      {phase.state === "error" ? (
        <div className="flex flex-col items-start gap-2">
          {pairing?.error ? (
            <p className="text-ui-base text-destructive">
              {describeRemotePairingError(pairing.error, intl)}
            </p>
          ) : null}
          <Button type="button" size="lg" disabled={busy} onClick={() => void onStart()}>
            {startingPairing ? (
              <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
            ) : null}
            {intl.formatMessage({ id: "settings.remoteControl.pairing.retry" })}
          </Button>
        </div>
      ) : null}

      <AlertDialog open={restartConfirmOpen} onOpenChange={setRestartConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {intl.formatMessage({ id: "settings.remoteControl.pairing.restartConfirmTitle" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {intl.formatMessage({
                id: "settings.remoteControl.pairing.restartConfirmDescription",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{intl.formatMessage({ id: "common.cancel" })}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                setRestartConfirmOpen(false);
                void onStart();
              }}
            >
              {intl.formatMessage({ id: "settings.remoteControl.pairing.restartConfirmAction" })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
