// 远程控制设置段（基础设置）：连接配置、安全与隐私。
// 配置/配对状态/设备列表的唯一所有者是 Desktop Main（cfworker-remote/PROTOCOL.md §6.3），
// Renderer 经 useRemoteControl（remoteControlBridge 能力面）读写，不触碰 window.lcode。
// 「手机配对」已独立为 MobileRemoteControlPanel（侧栏 footer 弹框），设置段不再重复承载。
import { usePlatform } from "@/hooks/usePlatform.js";
import { useRemoteControl } from "@/hooks/useRemoteControl.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { RemoteControlConnectionSettings } from "@/settings/RemoteControlConnectionSettings.js";
import { RemoteControlSecuritySettings } from "@/settings/RemoteControlSecuritySettings.js";

export function RemoteControlSettingsSection() {
  const { intl } = useLCodeIntl();
  const platform = usePlatform();
  const {
    bridge,
    config,
    configLoading,
    configSaving,
    devices,
    devicesLoading,
    deviceActionPendingId,
    testingConnection,
    refreshDevices,
    saveConfig,
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
