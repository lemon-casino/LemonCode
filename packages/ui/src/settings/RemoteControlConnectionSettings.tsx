// 远程控制「连接」卡片：启用开关、Worker 域名、接入 Key、测试连接。
// 域名/Key 的草稿是卡片局部状态；保存一律经 useRemoteControl.saveConfig，
// 以 Main 回读（config-get）为准，不在 Renderer 维护第二份配置事实。
// 接入 Key 明文只允许停留在输入框里直到保存动作结束，成功/失败都立即清空，
// 界面只回显 Main 给出的 hasAccessKey（契约 PROTOCOL.md §6.3：永不回明文）。
import { useCallback, useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import {
  DEFAULT_REMOTE_CONTROL_WORKER_BASE_URL,
  isDefaultRemoteControlWorkerBaseUrl,
  normalizeRemoteControlWorkerBaseUrl,
} from "@lcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Switch } from "@/components/ui/switch.js";
import { toast } from "@/components/ui/toast.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { startUserAction } from "@/lib/userActionTelemetry.js";
import { commitRemoteControlConfig } from "@/settings/remoteControlSettingsShared.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import type {
  RemoteControlConfig,
  RemoteControlConfigPatch,
  RemoteControlTestResult,
} from "@/settings/remoteControlBridge.js";

interface RemoteControlConnectionSettingsProps {
  config: RemoteControlConfig | null;
  configLoading: boolean;
  configSaving: boolean;
  saveConfig: (patch: RemoteControlConfigPatch) => Promise<{ success: boolean; error?: string }>;
  testConnection: () => Promise<RemoteControlTestResult | null>;
  testingConnection: boolean;
  /** 平台是否实现了契约外的可选「测试连接」能力;未实现时按钮禁用而不是点了没反应。 */
  testSupported: boolean;
}

export function RemoteControlConnectionSettings({
  config,
  configLoading,
  configSaving,
  saveConfig,
  testConnection,
  testingConnection,
  testSupported,
}: RemoteControlConnectionSettingsProps) {
  const { intl } = useLCodeIntl();
  const [workerBaseUrlDraft, setWorkerBaseUrlDraft] = useState(
    DEFAULT_REMOTE_CONTROL_WORKER_BASE_URL,
  );
  const workerBaseUrlTouched = useRef(false);
  const [accessKeyDraft, setAccessKeyDraft] = useState("");
  const [testResult, setTestResult] = useState<RemoteControlTestResult | null>(null);

  // 配置以 Main 回读为准；用户尚未编辑时回填，不覆盖正在编辑的内容，
  // 避免设置页开着时 Main 的回读把输入冲掉。
  useEffect(() => {
    if (config && !workerBaseUrlTouched.current) {
      setWorkerBaseUrlDraft(config.workerBaseUrl);
    }
  }, [config]);

  // 空输入明确表示恢复官方托管地址，不把“空”持久化为第二种默认状态。
  const normalizedWorkerBaseUrlDraft = workerBaseUrlDraft.trim()
    ? normalizeRemoteControlWorkerBaseUrl(workerBaseUrlDraft)
    : DEFAULT_REMOTE_CONTROL_WORKER_BASE_URL;
  const workerBaseUrlDirty =
    normalizedWorkerBaseUrlDraft !==
    (config?.workerBaseUrl ?? DEFAULT_REMOTE_CONTROL_WORKER_BASE_URL);
  const managedService = isDefaultRemoteControlWorkerBaseUrl(
    normalizedWorkerBaseUrlDraft ?? workerBaseUrlDraft,
  );

  const handleEnabledChange = useCallback(
    async (enabled: boolean) => {
      if (!config) return;
      // 官方托管服务不分发共享 Key；自建 Worker 仍须先保存部署 Key。
      if (
        enabled &&
        !(
          config.workerBaseUrl &&
          (isDefaultRemoteControlWorkerBaseUrl(config.workerBaseUrl) || config.hasAccessKey)
        )
      ) {
        toast(intl.formatMessage({ id: "settings.remoteControl.enable.missingPrerequisites" }));
        return;
      }
      const trace = startUserAction({
        featureId: "settings.remoteControl",
        action: "toggle_enable",
        trigger: "switch",
      });
      const result = await saveConfig({ enabled });
      if (result.success) {
        trace.complete({
          resultSource: "platform_result",
          stateAfter: enabled ? "enabled" : "disabled",
        });
        toast(
          intl.formatMessage({
            id: enabled
              ? "settings.remoteControl.enable.enabledToast"
              : "settings.remoteControl.enable.disabledToast",
          }),
        );
        return;
      }
      trace.fail({ failureStage: "settings_commit" });
      toast(
        result.error
          ? intl.formatMessage(
              { id: "settings.remoteControl.config.saveFailedWithReason" },
              { error: result.error },
            )
          : intl.formatMessage({ id: "settings.remoteControl.config.saveFailed" }),
      );
    },
    [config, intl, saveConfig],
  );

  const handleSaveWorkerBaseUrl = useCallback(async () => {
    // 与 Main/Worker 同口径（@lcode/shared）：仅接受 https，或 localhost 系的 http。
    const normalized = normalizedWorkerBaseUrlDraft;
    if (!normalized) {
      toast(intl.formatMessage({ id: "settings.remoteControl.workerBaseUrl.invalid" }));
      return;
    }
    const saved = await commitRemoteControlConfig({
      intl,
      saveConfig,
      patch: { workerBaseUrl: normalized },
      action: "save_worker_base_url",
      trigger: "button",
      successMessageId: "settings.remoteControl.config.saved",
    });
    if (saved) {
      workerBaseUrlTouched.current = false;
      setWorkerBaseUrlDraft(normalized);
    }
  }, [intl, normalizedWorkerBaseUrlDraft, saveConfig]);

  const handleSaveAccessKey = useCallback(async () => {
    const accessKey = accessKeyDraft.trim();
    if (!accessKey) return;
    const trace = startUserAction({
      featureId: "settings.remoteControl",
      action: "save_access_key",
      trigger: "button",
    });
    const result = await saveConfig({ accessKey });
    // 无论成败都立即清空输入：明文只允许在输入框里停留到保存动作结束。
    setAccessKeyDraft("");
    if (result.success) {
      trace.complete({ resultSource: "platform_result" });
      toast(intl.formatMessage({ id: "settings.remoteControl.accessKey.saved" }));
      return;
    }
    trace.fail({ failureStage: "settings_commit" });
    toast(
      result.error
        ? intl.formatMessage(
            { id: "settings.remoteControl.config.saveFailedWithReason" },
            { error: result.error },
          )
        : intl.formatMessage({ id: "settings.remoteControl.config.saveFailed" }),
    );
  }, [accessKeyDraft, intl, saveConfig]);

  const handleTestConnection = useCallback(async () => {
    const trace = startUserAction({
      featureId: "settings.remoteControl",
      action: "test_connection",
      trigger: "button",
    });
    const result = await testConnection();
    if (!result) {
      // 平台未提供测试连接能力（契约外可选通道），按钮已禁用，正常不会走到这里。
      trace.fail({ failureStage: "capability_missing" });
      return;
    }
    setTestResult(result);
    if (result.success) {
      trace.complete({ resultSource: "platform_result" });
      return;
    }
    trace.fail({ failureStage: "health_check_failed" });
    // 健康检查失败原因不含凭据，可以记日志辅助定位域名/部署问题。
    logger.warn("[remote-control] 测试连接失败", { error: result.error ?? null });
  }, [testConnection]);

  return (
    <SettingsGroupCard>
      <SettingsRow
        label={intl.formatMessage({ id: "settings.remoteControl.enable.title" })}
        description={intl.formatMessage({ id: "settings.remoteControl.enable.description" })}
        control={
          <Switch
            aria-label={intl.formatMessage({ id: "settings.remoteControl.enable.title" })}
            data-testid="remote-control-enabled-switch"
            checked={config?.enabled === true}
            disabled={configLoading || configSaving || !config}
            onCheckedChange={(checked) => void handleEnabledChange(checked)}
          />
        }
      />
      <SettingsRow
        label={intl.formatMessage({ id: "settings.remoteControl.workerBaseUrl.title" })}
        description={intl.formatMessage({ id: "settings.remoteControl.workerBaseUrl.description" })}
        control={
          <Button
            type="button"
            size="lg"
            disabled={configSaving || !workerBaseUrlDirty}
            onClick={() => void handleSaveWorkerBaseUrl()}
          >
            {intl.formatMessage({ id: "settings.remoteControl.config.save" })}
          </Button>
        }
        detail={
          <Input
            size="lg"
            value={workerBaseUrlDraft}
            placeholder={DEFAULT_REMOTE_CONTROL_WORKER_BASE_URL}
            data-testid="remote-control-worker-base-url"
            onChange={(event) => {
              workerBaseUrlTouched.current = true;
              setWorkerBaseUrlDraft(event.currentTarget.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && workerBaseUrlDirty) {
                void handleSaveWorkerBaseUrl();
              }
            }}
            className="max-w-[520px] font-mono"
          />
        }
      />
      <SettingsRow
        label={intl.formatMessage({ id: "settings.remoteControl.accessKey.title" })}
        description={intl.formatMessage({ id: "settings.remoteControl.accessKey.description" })}
        control={
          <Button
            type="button"
            size="lg"
            disabled={managedService || configSaving || accessKeyDraft.trim() === ""}
            onClick={() => void handleSaveAccessKey()}
          >
            {intl.formatMessage({ id: "settings.remoteControl.accessKey.save" })}
          </Button>
        }
        detail={
          <div className="flex max-w-[520px] flex-col gap-1">
            <Input
              size="lg"
              type="password"
              autoComplete="off"
              disabled={managedService}
              value={accessKeyDraft}
              placeholder={intl.formatMessage({
                id: "settings.remoteControl.accessKey.placeholder",
              })}
              data-testid="remote-control-access-key"
              onChange={(event) => setAccessKeyDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && accessKeyDraft.trim() !== "") {
                  void handleSaveAccessKey();
                }
              }}
              className="font-mono"
            />
            <div
              className="text-ui-xs text-foreground-subtle"
              data-testid="remote-control-access-key-state"
            >
              {intl.formatMessage({
                id: managedService
                  ? "settings.remoteControl.accessKey.managedService"
                  : config?.hasAccessKey
                    ? "settings.remoteControl.accessKey.configured"
                    : "settings.remoteControl.accessKey.notConfigured",
              })}
            </div>
          </div>
        }
      />
      <SettingsRow
        label={intl.formatMessage({ id: "settings.remoteControl.testConnection.title" })}
        description={intl.formatMessage({
          id: "settings.remoteControl.testConnection.description",
        })}
        control={
          <Button
            type="button"
            size="lg"
            variant="outline"
            disabled={testingConnection || !testSupported || !config?.workerBaseUrl}
            data-testid="remote-control-test-connection"
            onClick={() => void handleTestConnection()}
          >
            {testingConnection ? (
              <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
            ) : null}
            {intl.formatMessage({ id: "settings.remoteControl.testConnection.action" })}
          </Button>
        }
        detail={
          testResult ? (
            <div
              className={`text-ui-base ${testResult.success ? "text-foreground-subtle" : "text-destructive"}`}
            >
              {testResult.success
                ? intl.formatMessage(
                    { id: "settings.remoteControl.testConnection.success" },
                    { latencyMs: testResult.latencyMs ?? 0 },
                  )
                : intl.formatMessage(
                    { id: "settings.remoteControl.testConnection.failed" },
                    { error: testResult.error ?? "" },
                  )}
            </div>
          ) : undefined
        }
      />
    </SettingsGroupCard>
  );
}
