import { useState } from "react";
import { DEFAULT_TOKEN_USAGE_STATUS_BAR, type TokenUsageStatusBarSettings } from "@lcode/shared";
import { Switch } from "@/components/ui/switch.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { toast } from "@/components/ui/toast.js";
import { useTokenUsageStatusBarSettings } from "@/hooks/useTokenUsageStatusBarSettings.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

export function TokenUsageStatusBarSection() {
  const { intl } = useLCodeIntl();
  const { settings, update, preferences: value } = useTokenUsageStatusBarSettings();
  const [saving, setSaving] = useState(false);
  const change = async (patch: Partial<TokenUsageStatusBarSettings>) => {
    setSaving(true);
    try {
      await update({ tokenUsageStatusBar: { ...value, ...patch } });
    } catch (error) {
      logger.warn("[settings] 保存 Token 用量状态栏设置失败", { error: String(error) });
      toast(intl.formatMessage({ id: "settings.tokenUsageStatusBar.saveError" }));
    } finally {
      setSaving(false);
    }
  };
  return (
    <section className="space-y-4" data-testid="token-usage-statusbar-settings">
      <p className="text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.tokenUsageStatusBar.description" })}
      </p>
      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({ id: "settings.tokenUsageStatusBar.position" })}
          description={intl.formatMessage({
            id: "settings.tokenUsageStatusBar.positionDescription",
          })}
          control={
            <Select
              value={value.position}
              disabled={!settings || saving || !value.enabled}
              onValueChange={(position) =>
                void change({ position: position as TokenUsageStatusBarSettings["position"] })
              }
            >
              <SelectTrigger
                className="w-full"
                data-testid="token-usage-statusbar-position"
                aria-label={intl.formatMessage({ id: "settings.tokenUsageStatusBar.position" })}
              >
                <SelectValue />
              </SelectTrigger>
              {/* 设置滚动区内，item-aligned 的重复 onPlaced 会触发更新循环；
                  采用模型速度控件同款 popper 锚定，交由 Radix 做视口碰撞处理。 */}
              <SelectContent position="popper" align="end" sideOffset={4} collisionPadding={8}>
                {(["inside", "below", "above"] as const).map((position) => (
                  <SelectItem key={position} value={position}>
                    {intl.formatMessage({
                      id: `settings.tokenUsageStatusBar.position.${position}`,
                    })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
        {Object.keys(DEFAULT_TOKEN_USAGE_STATUS_BAR)
          .filter((key) => key !== "position")
          .map((field) => {
            const key = field as Exclude<keyof TokenUsageStatusBarSettings, "position">;
            const label = intl.formatMessage({ id: `settings.tokenUsageStatusBar.${key}` });
            return (
              <SettingsRow
                key={key}
                label={label}
                description={intl.formatMessage({
                  id: `settings.tokenUsageStatusBar.${key}Description`,
                })}
                control={
                  <Switch
                    checked={value[key]}
                    disabled={!settings || saving || (key !== "enabled" && !value.enabled)}
                    aria-label={label}
                    data-testid={`token-usage-statusbar-toggle-${key}`}
                    onCheckedChange={(checked) => void change({ [key]: checked })}
                  />
                }
              />
            );
          })}
      </SettingsGroupCard>
    </section>
  );
}
