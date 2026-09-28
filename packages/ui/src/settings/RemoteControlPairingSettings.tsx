// 远程控制「手机配对」卡片：把 hook 提供的配对状态与操作装配成面板。
// 主开关未开启时不渲染面板——主开关是功能总闸，关闭时 Main 不得产生任何出站请求
// （specs/mobile-remote-control-cf-workers.md 验收）。
import { useCallback, useMemo } from "react";
import { toast } from "@/components/ui/toast.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { startUserAction } from "@/lib/userActionTelemetry.js";
import { buildRemotePairingMirrorTarget } from "@/settings/remoteControlBridge.js";
import { RemotePairingPanel } from "@/settings/RemotePairingPanel.js";
import { SettingsGroupCard } from "@/settings/SettingsPageParts.js";
import type {
  RemotePairingStartRequest,
  RemotePairingStartResult,
  RemotePairingStateEvent,
} from "@/settings/remoteControlBridge.js";
import type { RemoteControlMirrorWorkspace } from "@/settings/RemoteControlSettingsSection.js";

interface RemoteControlPairingSettingsProps {
  enabled: boolean;
  /** 激活 workspace 上下文;组装不出镜像 target 时禁止开启等待(fail-closed 提前)。 */
  mirrorWorkspace?: RemoteControlMirrorWorkspace;
  pairing: RemotePairingStateEvent | null;
  pairingUrl: string | null;
  startingPairing: boolean;
  stoppingPairing: boolean;
  startPairing: (request?: RemotePairingStartRequest) => Promise<RemotePairingStartResult | null>;
  stopPairing: () => Promise<void>;
  decidePairing: (requestId: string, accept: boolean) => Promise<void>;
}

export function RemoteControlPairingSettings({
  enabled,
  mirrorWorkspace,
  pairing,
  pairingUrl,
  startingPairing,
  stoppingPairing,
  startPairing,
  stopPairing,
  decidePairing,
}: RemoteControlPairingSettingsProps) {
  const { intl } = useLCodeIntl();

  // target.windowId 是占位值(Main handler 按可信 IPC sender 权威覆盖,见
  // remoteControlBridge.ts 的 REMOTE_PAIRING_PLACEHOLDER_WINDOW_ID 注释);
  // 组装不出 target(激活的不是远程 workspace)时禁用开启等待——否则配对会在
  // bridge.open 后才以 MIRROR_TARGET_MISSING fail-closed 关房,手机侧白扫一次。
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
    const result = await startPairing(mirrorTarget ? { target: mirrorTarget } : undefined);
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
      intl.formatMessage({ id: "settings.remoteControl.pairing.startFailed" }, { error: result.error }),
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
    <SettingsGroupCard>
      <div className="px-4 py-4">
        {enabled ? (
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
          <p className="text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "settings.remoteControl.pairing.disabledHint" })}
          </p>
        )}
      </div>
    </SettingsGroupCard>
  );
}
