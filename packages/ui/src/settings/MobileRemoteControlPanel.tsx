// 手机配对独立块：footer「移动端远程控制」弹框的唯一内容组件。
// 由设置页「手机配对」分区独立而来（specs/mobile-remote-control-cf-workers.md 入口迁移），
// 自持 useRemoteControl 装配（配置快照 + lcode:remote-pairing-state 推送），不持第二份房间状态；
// 配对交互本体仍是 RemotePairingPanel（等待/裁决/已就绪/停止/刷新二维码/复制链接的唯一投影）。
import { LoaderCircle, MonitorSmartphone, Settings2, Smartphone } from "lucide-react";
import { useCallback, useMemo } from "react";
import { toast } from "@/components/ui/toast.js";
import { Button } from "@/components/ui/button.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useRemoteControl } from "@/hooks/useRemoteControl.js";
import { logger } from "@/logger.js";
import { startUserAction } from "@/lib/userActionTelemetry.js";
import { RemotePairingPanel } from "@/settings/RemotePairingPanel.js";
import {
  buildRemotePairingMirrorTarget,
  type RemotePairingStartResult,
} from "@/settings/remoteControlBridge.js";

/** 激活 workspace 上下文(tabStore 权威),用于组装手机镜像 target;由调用方传入。 */
export interface RemoteControlMirrorWorkspace {
  remoteSessionId?: string | null;
  workspacePath?: string | null;
  workspaceIdentity?: string | null;
}

export function MobileRemoteControlPanel({
  mirrorWorkspace,
  onOpenSettings,
}: {
  /** 组装不出镜像 target 时「开启等待」禁用并提示（fail-closed 提前，手机不白扫）。 */
  mirrorWorkspace?: RemoteControlMirrorWorkspace;
  /** 跳转远程控制设置分区（填写域名/接入 Key、启用开关、安全隐私）的出口。 */
  onOpenSettings?: () => void;
} = {}) {
  const { intl } = useLCodeIntl();
  const platform = usePlatform();
  const {
    bridge,
    config,
    configLoading,
    pairing,
    pairingUrl,
    startingPairing,
    stoppingPairing,
    startPairing,
    stopPairing,
    decidePairing,
  } = useRemoteControl(platform);

  // target.windowId 是占位值(Main handler 按可信 IPC sender 权威覆盖,见
  // remoteControlBridge.ts 的 REMOTE_PAIRING_PLACEHOLDER_WINDOW_ID 注释)。
  const mirrorTarget = useMemo(
    () => buildRemotePairingMirrorTarget(mirrorWorkspace ?? {}),
    [mirrorWorkspace],
  );
  const canStart = mirrorTarget !== null;

  const handleStartPairing = useCallback(async () => {
    const trace = startUserAction({
      featureId: "settings.remoteControl",
      action: "pairing_start",
      trigger: "button",
    });
    const result: RemotePairingStartResult | null = await startPairing(
      mirrorTarget ? { target: mirrorTarget } : undefined,
    );
    if (!result) {
      // 平台能力缺失时面板不会渲染，这里只是兜底埋点。
      trace.fail({ failureStage: "capability_missing" });
      return;
    }
    if (result.success) {
      trace.complete({ resultSource: "platform_result" });
      return;
    }
    trace.fail({ failureStage: "pairing_start_failed" });
    toast(
      intl.formatMessage(
        { id: "settings.remoteControl.pairing.startFailed" },
        { error: result.error },
      ),
    );
  }, [intl, mirrorTarget, startPairing]);

  const handleStopPairing = useCallback(async () => {
    const trace = startUserAction({
      featureId: "settings.remoteControl",
      action: "pairing_stop",
      trigger: "button",
    });
    try {
      await stopPairing();
      trace.complete({ resultSource: "platform_result" });
    } catch (error) {
      trace.fail({ failureStage: "pairing_stop_failed" });
      logger.warn("[remote-control] 停止配对失败", {
        error: error instanceof Error ? error.message : String(error),
      });
      toast(intl.formatMessage({ id: "settings.remoteControl.pairing.stopFailed" }));
    }
  }, [intl, stopPairing]);

  const handleDecidePairing = useCallback(
    async (requestId: string, accept: boolean) => {
      const trace = startUserAction({
        featureId: "settings.remoteControl",
        action: "pairing_decide",
        trigger: "button",
      });
      try {
        await decidePairing(requestId, accept);
        // 裁决后的面板状态以 Main 推送为准（accepted/rejected → bridged/waiting）。
        trace.complete({ resultSource: "platform_result" });
      } catch (error) {
        trace.fail({ failureStage: "pairing_decide_failed" });
        logger.warn("[remote-control] 配对裁决提交失败", {
          error: error instanceof Error ? error.message : String(error),
        });
        toast(intl.formatMessage({ id: "settings.remoteControl.pairing.decideFailed" }));
      }
    },
    [decidePairing, intl],
  );

  return (
    <div className="flex flex-col gap-3 p-4" data-testid="mobile-remote-control-panel">
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-surface">
          <MonitorSmartphone className="size-5 text-foreground" />
        </div>
        <div className="min-w-0">
          <div className="text-ui-base font-semibold text-foreground">
            {intl.formatMessage({ id: "remoteControl.quick.title" })}
          </div>
          <p className="mt-0.5 text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "remoteControl.quick.description" })}
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-surface px-3 py-3">
        <div className="flex items-center gap-2">
          <Smartphone className="size-4 text-foreground" />
          <span className="text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "remoteControl.quick.scanTitle" })}
          </span>
        </div>
        <p className="mt-1 text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "remoteControl.quick.scanDescription" })}
        </p>

        <div className="mt-3">
          {bridge ? (
            configLoading ? (
              <div className="flex items-center gap-2 text-ui-base text-foreground-subtle">
                <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                {intl.formatMessage({ id: "common.loading" })}
              </div>
            ) : config?.enabled ? (
              <RemotePairingPanel
                canStart={canStart}
                noMirrorTargetHint={intl.formatMessage({
                  id: "settings.remoteControl.pairing.noMirrorTarget",
                })}
                pairing={pairing}
                pairingUrl={pairingUrl}
                startingPairing={startingPairing}
                stoppingPairing={stoppingPairing}
                onStart={handleStartPairing}
                onStop={handleStopPairing}
                onDecide={handleDecidePairing}
              />
            ) : (
              // 主开关是功能总闸：关闭时 Main 不产生任何出站请求，弹框只给去开启的出口。
              <p className="text-ui-base text-foreground-subtle">
                {intl.formatMessage({ id: "remoteControl.quick.disabledHint" })}
              </p>
            )
          ) : (
            // 当前桌面的 preload 版本早于远程控制能力：如实降级，不渲染点了没反应的控件。
            <p className="text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "settings.remoteControl.unavailable" })}
            </p>
          )}
        </div>
      </div>

      {onOpenSettings ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="self-start gap-1.5 text-foreground-subtle"
          onClick={onOpenSettings}
        >
          <Settings2 className="size-4" />
          {intl.formatMessage({ id: "remoteControl.quick.openSettings" })}
        </Button>
      ) : null}
    </div>
  );
}
