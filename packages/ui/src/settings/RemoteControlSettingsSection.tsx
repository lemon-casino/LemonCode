// 远程控制设置段（基础设置）：连接配置、手机配对面板、安全与隐私。
// 配置/配对状态/设备列表的唯一所有者是 Desktop Main（cfworker-remote/PROTOCOL.md §6.3），
// Renderer 经 useRemoteControl（remoteControlBridge 能力面）读写，不触碰 window.lcode。
import { usePlatform } from "@/hooks/usePlatform.js";
import { useRemoteControl } from "@/hooks/useRemoteControl.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { RemoteControlConnectionSettings } from "@/settings/RemoteControlConnectionSettings.js";
import { RemoteControlPairingSettings } from "@/settings/RemoteControlPairingSettings.js";
import { RemoteControlSecuritySettings } from "@/settings/RemoteControlSecuritySettings.js";

/** 激活 workspace 上下文(tabStore 权威),用于组装手机镜像 target;由 SettingsPage 传入。 */
export interface RemoteControlMirrorWorkspace {
  remoteSessionId?: string | null;
  workspacePath?: string | null;
  workspaceIdentity?: string | null;
}

export function RemoteControlSettingsSection({
  mirrorWorkspace,
}: {
  mirrorWorkspace?: RemoteControlMirrorWorkspace;
} = {}) {
  const { intl } = useLCodeIntl();
  const platform = usePlatform();
  const {
    bridge,
    config,
    configLoading,
    configSaving,
    pairing,
    pairingUrl,
    startingPairing,
    stoppingPairing,
    devices,
    devicesLoading,
    deviceActionPendingId,
    testingConnection,
    refreshDevices,
    saveConfig,
    startPairing,
    stopPairing,
    decidePairing,
    revokeDevice,
    testConnection,
  } = useRemoteControl(platform);

  if (!bridge) {
    // 分区只在桌面注册；走到这里说明当前桌面的 preload 版本还早于远程控制能力，
    // 按既有设置段的 desktopOnly 形态提示，而不是渲染一组点了没反应的控件。
    return (
      <div className="rounded-lg border border-border bg-surface px-4 py-3 text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.remoteControl.unavailable" })}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <section className="space-y-3">
        <RemoteControlConnectionSettings
          config={config}
          configLoading={configLoading}
          configSaving={configSaving}
          saveConfig={saveConfig}
          testConnection={testConnection}
          testingConnection={testingConnection}
          testSupported={bridge.testRemoteControlConnection !== undefined}
        />
      </section>

      <section className="space-y-3">
        <div className="text-ui-base font-medium text-foreground-subtle">
          {intl.formatMessage({ id: "settings.remoteControl.pairing.section" })}
        </div>
        <RemoteControlPairingSettings
          enabled={config?.enabled === true}
          mirrorWorkspace={mirrorWorkspace}
          pairing={pairing}
          pairingUrl={pairingUrl}
          startingPairing={startingPairing}
          stoppingPairing={stoppingPairing}
          startPairing={startPairing}
          stopPairing={stopPairing}
          decidePairing={decidePairing}
        />
      </section>

      <section className="space-y-3">
        <div className="text-ui-base font-medium text-foreground-subtle">
          {intl.formatMessage({ id: "settings.remoteControl.security.section" })}
        </div>
        <RemoteControlSecuritySettings
          config={config}
          configLoading={configLoading}
          configSaving={configSaving}
          saveConfig={saveConfig}
          devices={devices}
          devicesLoading={devicesLoading}
          deviceActionPendingId={deviceActionPendingId}
          refreshDevices={refreshDevices}
          revokeDevice={revokeDevice}
        />
      </section>
    </div>
  );
}
