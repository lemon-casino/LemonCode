// 远程控制「安全与隐私」卡片：允许新设备配对、配对链接有效期、空闲自动断开、
// 隐私说明与已授权设备列表（吊销）。设备列表事实源在 Desktop Main
// （PROTOCOL.md §6.3 lcode:remote-devices-refresh），Renderer 只读快照 + 显式刷新。
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
import { Button } from "@/components/ui/button.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Switch } from "@/components/ui/switch.js";
import { toast } from "@/components/ui/toast.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { startUserAction } from "@/lib/userActionTelemetry.js";
import { formatDateTime } from "@/settings/automationFormat.js";
import {
  buildDurationOptions,
  commitRemoteControlConfig,
  formatDurationMs,
  IDLE_DISCONNECT_OPTIONS_MS,
  PAIRING_TTL_OPTIONS_MS,
} from "@/settings/remoteControlSettingsShared.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import type {
  RemoteControlConfig,
  RemoteControlConfigPatch,
  RemoteControlDevice,
} from "@/settings/remoteControlBridge.js";

interface RemoteControlSecuritySettingsProps {
  config: RemoteControlConfig | null;
  configLoading: boolean;
  configSaving: boolean;
  saveConfig: (
    patch: RemoteControlConfigPatch,
  ) => Promise<{ success: boolean; error?: string }>;
  devices: RemoteControlDevice[];
  devicesLoading: boolean;
  deviceActionPendingId: string | null;
  refreshDevices: () => Promise<void>;
  revokeDevice: (deviceId: string) => Promise<void>;
}

export function RemoteControlSecuritySettings({
  config,
  configLoading,
  configSaving,
  saveConfig,
  devices,
  devicesLoading,
  deviceActionPendingId,
  refreshDevices,
  revokeDevice,
}: RemoteControlSecuritySettingsProps) {
  const { intl } = useLCodeIntl();
  const [devicePendingRevoke, setDevicePendingRevoke] = useState<RemoteControlDevice | null>(null);

  const handleRevokeDevice = useCallback(
    async (device: RemoteControlDevice) => {
      setDevicePendingRevoke(null);
      const trace = startUserAction({
        featureId: "settings.remoteControl",
        action: "revoke_device",
        trigger: "button",
      });
      try {
        await revokeDevice(device.deviceId);
        trace.complete({ resultSource: "platform_result" });
        toast(intl.formatMessage({ id: "settings.remoteControl.devices.revokedToast" }));
      } catch (error) {
        trace.fail({ failureStage: "device_revoke_failed" });
        logger.warn("[remote-control] 吊销设备失败", {
          error: error instanceof Error ? error.message : String(error),
        });
        toast(intl.formatMessage({ id: "settings.remoteControl.devices.revokeFailed" }));
      }
    },
    [intl, revokeDevice],
  );

  return (
    <>
      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({ id: "settings.remoteControl.allowNewDevices.title" })}
          description={intl.formatMessage({
            id: "settings.remoteControl.allowNewDevices.description",
          })}
          control={
            <Switch
              aria-label={intl.formatMessage({
                id: "settings.remoteControl.allowNewDevices.title",
              })}
              data-testid="remote-control-allow-new-devices"
              checked={config?.allowNewDevices === true}
              disabled={configLoading || configSaving || !config}
              onCheckedChange={(checked) =>
                void commitRemoteControlConfig({
                  intl,
                  saveConfig,
                  patch: { allowNewDevices: checked },
                  action: "toggle_allow_new_devices",
                  trigger: "switch",
                  successMessageId: "settings.remoteControl.config.saved",
                })
              }
            />
          }
        />
        <SettingsRow
          label={intl.formatMessage({ id: "settings.remoteControl.pairingTtl.title" })}
          description={intl.formatMessage({ id: "settings.remoteControl.pairingTtl.description" })}
          control={
            <Select
              value={config ? String(config.pairingTtlMs) : undefined}
              disabled={configSaving || !config}
              onValueChange={(value) => {
                void commitRemoteControlConfig({
                  intl,
                  saveConfig,
                  patch: { pairingTtlMs: Number(value) },
                  action: "change_pairing_ttl",
                  trigger: "select",
                  successMessageId: "settings.remoteControl.config.saved",
                });
              }}
            >
              <SelectTrigger size="lg" className="w-48 min-w-0 justify-between">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {buildDurationOptions(config?.pairingTtlMs, PAIRING_TTL_OPTIONS_MS).map((ms) => (
                  <SelectItem key={ms} value={String(ms)}>
                    {formatDurationMs(ms, intl)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
        <SettingsRow
          label={intl.formatMessage({ id: "settings.remoteControl.idleDisconnect.title" })}
          description={intl.formatMessage({
            id: "settings.remoteControl.idleDisconnect.description",
          })}
          control={
            <Select
              value={config ? String(config.idleDisconnectMs) : undefined}
              disabled={configSaving || !config}
              onValueChange={(value) => {
                void commitRemoteControlConfig({
                  intl,
                  saveConfig,
                  patch: { idleDisconnectMs: Number(value) },
                  action: "change_idle_disconnect",
                  trigger: "select",
                  successMessageId: "settings.remoteControl.config.saved",
                });
              }}
            >
              <SelectTrigger size="lg" className="w-48 min-w-0 justify-between">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {buildDurationOptions(config?.idleDisconnectMs, IDLE_DISCONNECT_OPTIONS_MS).map(
                  (ms) => (
                    <SelectItem key={ms} value={String(ms)}>
                      {ms === 0
                        ? intl.formatMessage({ id: "settings.remoteControl.idleDisconnect.never" })
                        : formatDurationMs(ms, intl)}
                    </SelectItem>
                  ),
                )}
              </SelectContent>
            </Select>
          }
        />
        <div className="border-t border-border px-4 py-3">
          {/* v1 不做端到端加密：Worker 以 TLS 终止并可看到帧内容（PROTOCOL.md §8），
              按方案要求在设置页如实标注。 */}
          <p className="text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "settings.remoteControl.privacy.note" })}
          </p>
        </div>
      </SettingsGroupCard>

      <section className="space-y-3">
        <div className="text-ui-base font-medium text-foreground-subtle">
          {intl.formatMessage({ id: "settings.remoteControl.devices.section" })}
        </div>
        <SettingsGroupCard>
          {devicesLoading ? (
            <div className="px-4 py-3 text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "settings.remoteControl.devices.loading" })}
            </div>
          ) : devices.length === 0 ? (
            <div className="px-4 py-3 text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "settings.remoteControl.devices.empty" })}
            </div>
          ) : (
            devices.map((device) => (
              <SettingsRow
                key={device.deviceId}
                label={device.deviceName?.trim() || device.deviceId}
                description={`${intl.formatMessage({ id: "settings.remoteControl.devices.grantedAt" }, { time: formatDateTime(device.grantedAt) })} · ${intl.formatMessage({ id: "settings.remoteControl.devices.lastSeenAt" }, { time: formatDateTime(device.lastSeenAt) })}`}
                control={
                  <Button
                    type="button"
                    size="lg"
                    variant="destructive"
                    disabled={deviceActionPendingId === device.deviceId}
                    data-testid={`remote-control-device-revoke-${device.deviceId}`}
                    onClick={() => setDevicePendingRevoke(device)}
                  >
                    {deviceActionPendingId === device.deviceId ? (
                      <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                    ) : null}
                    {intl.formatMessage({ id: "settings.remoteControl.devices.revoke" })}
                  </Button>
                }
              />
            ))
          )}
        </SettingsGroupCard>
        <div className="flex items-center justify-between px-1">
          <span className="text-ui-xs text-foreground-subtlest">
            {intl.formatMessage({ id: "settings.remoteControl.devices.refreshHint" })}
          </span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={devicesLoading}
            onClick={() => void refreshDevices()}
          >
            {intl.formatMessage({ id: "settings.remoteControl.devices.refresh" })}
          </Button>
        </div>
      </section>

      <AlertDialog
        open={devicePendingRevoke !== null}
        onOpenChange={(open) => {
          if (!open) setDevicePendingRevoke(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {intl.formatMessage({ id: "settings.remoteControl.devices.revokeConfirmTitle" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {intl.formatMessage(
                { id: "settings.remoteControl.devices.revokeConfirmDescription" },
                {
                  deviceName:
                    devicePendingRevoke?.deviceName?.trim() || devicePendingRevoke?.deviceId || "",
                },
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{intl.formatMessage({ id: "common.cancel" })}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={(event) => {
                event.preventDefault();
                if (devicePendingRevoke) {
                  void handleRevokeDevice(devicePendingRevoke);
                }
              }}
            >
              {intl.formatMessage({ id: "settings.remoteControl.devices.revokeConfirmAction" })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
