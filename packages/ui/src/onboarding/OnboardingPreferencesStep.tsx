import { Checkbox } from "@/components/ui/checkbox.js";
import { OnboardingThemeSelector } from "@/onboarding/OnboardingThemeSelector.js";
import type { Theme } from "@/useTheme.js";

type PreferenceKey = "suggestions" | "memory" | "sessionRecall" | "migration";

/**
 * 引导第 3 步（助手偏好）：主题选择 + 可勾选偏好。
 * 从 OccupationOnboarding 抽出以控制文件行数；状态仍由外层持有，
 * 这里只负责展示与回调，不复制任何偏好事实。
 */
export function OnboardingPreferencesStep({
  mode,
  theme,
  memory,
  sessionRecall,
  suggestions,
  migration,
  saving,
  onThemeSelect,
  onToggle,
  t,
}: {
  mode: string | null;
  theme: Theme;
  memory: boolean;
  sessionRecall: boolean;
  suggestions: boolean;
  migration: boolean;
  saving: boolean;
  onThemeSelect: (value: Theme) => void;
  onToggle: (key: PreferenceKey, checked: boolean) => void;
  t: (key: string) => string;
}) {
  const checkedFor = (key: PreferenceKey) =>
    key === "migration"
      ? migration
      : key === "memory"
        ? memory
        : key === "sessionRecall"
          ? sessionRecall
          : suggestions;
  return (
    <div className="mt-8 space-y-3">
      <OnboardingThemeSelector theme={theme} saving={saving} onSelect={onThemeSelect} />
      {(["suggestions", "memory", "sessionRecall", "migration"] as const)
        .filter((key) => key !== "suggestions" || mode === "office")
        .map((key) => (
          <label
            key={key}
            className="grid cursor-pointer grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 rounded-xl border border-card-border bg-card dark:bg-surface/40 p-5 text-ui-base transition-colors hover:bg-surface-hover"
          >
            <Checkbox
              checked={checkedFor(key)}
              disabled={saving}
              onCheckedChange={(checked) => onToggle(key, checked === true)}
            />
            <span className="font-medium">{t(key)}</span>
            <span className="col-start-2 text-ui-sm font-normal text-foreground-subtle">
              {t(`${key}Description`)}
            </span>
          </label>
        ))}
    </div>
  );
}
