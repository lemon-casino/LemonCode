import { Check } from "lucide-react";
import { ThemeSwatch } from "@/components/ui/ThemeSwatch.js";
import { cn } from "@/components/lib/utils.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { THEME_OPTIONS, type Theme } from "@/useTheme.js";

/**
 * 引导第一步的界面主题选择。
 * 主题名与色板都读 themeConfig 的 THEME_OPTIONS 注册表，不在这里另存白名单或色值
 * （spec: specs/ui-theme-modes.md）。选择立即经 store 的 setTheme 生效并写入
 * localStorage，用户当场看到真实效果，不需要等引导保存。
 */
export function OnboardingThemeSelector({
  theme,
  saving,
  onSelect,
}: {
  theme: Theme;
  saving: boolean;
  onSelect: (value: Theme) => void;
}) {
  const { intl } = useLCodeIntl();
  const label = intl.formatMessage({ id: "settings.themeMode" });
  return (
    <div className="mt-6" role="group" aria-label={label}>
      <p className="text-ui-sm font-medium text-foreground-subtle">{label}</p>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {THEME_OPTIONS.map((option) => {
          const selected = option.id === theme;
          return (
            <button
              key={option.id}
              type="button"
              aria-pressed={selected}
              disabled={saving}
              onClick={() => onSelect(option.id)}
              className={cn(
                "flex min-w-0 items-center gap-2 rounded-xl border px-3 py-2 text-left text-ui-base transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused",
                selected
                  ? "border-foreground/60 bg-card-selected dark:border-foreground/50"
                  : "border-card-border bg-card hover:border-border-hover hover:bg-surface-hover dark:border-border/60 dark:bg-transparent dark:hover:bg-surface/60",
              )}
            >
              <ThemeSwatch option={option} />
              {/* 窄屏与大字号下英文主题名可能超过一列；自然换行保留完整名称。 */}
              <span className="min-w-0 flex-1 whitespace-normal [overflow-wrap:anywhere]">
                {intl.formatMessage({ id: option.labelKey })}
              </span>
              {selected ? <Check className="size-3.5 shrink-0" /> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
