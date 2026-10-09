import { Check } from "lucide-react";
import { cn } from "@/components/lib/utils.js";

export interface OnboardingChoiceOption<T extends string> {
  value: T;
  label: string;
  description?: string;
}

/**
 * 引导里「从若干互斥选项里选一个」的通用单选组。
 * 与 OnboardingModeSelector 共用同一套卡片与选中标记样式，避免每个步骤各写一套视觉。
 */
export function OnboardingChoiceGroup<T extends string>({
  label,
  value,
  options,
  saving,
  onSelect,
  columns = 1,
}: {
  label: string;
  value: T;
  options: readonly OnboardingChoiceOption<T>[];
  saving: boolean;
  onSelect: (value: T) => void;
  columns?: 1 | 2;
}) {
  return (
    <div className="mt-6" role="radiogroup" aria-label={label}>
      <p className="text-ui-sm font-medium text-foreground-subtle">{label}</p>
      <div className={cn("mt-3 grid gap-2", columns === 2 && "sm:grid-cols-2")}>
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={saving}
              onClick={() => onSelect(option.value)}
              className={cn(
                "flex min-w-0 items-start gap-3 rounded-xl border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused",
                selected
                  ? "border-foreground/60 bg-card-selected dark:border-foreground/50"
                  : "border-card-border bg-card hover:border-border-hover hover:bg-surface-hover dark:border-border/60 dark:bg-transparent dark:hover:bg-surface/60",
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="block text-ui-base font-medium">{option.label}</span>
                {option.description ? (
                  <span className="mt-1.5 block text-ui-sm leading-relaxed text-foreground-subtle">
                    {option.description}
                  </span>
                ) : null}
              </span>
              <span
                aria-hidden="true"
                className={cn(
                  "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
                  selected ? "border-primary bg-primary text-primary-foreground" : "border-border",
                )}
              >
                {selected ? <Check className="size-3" /> : null}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
