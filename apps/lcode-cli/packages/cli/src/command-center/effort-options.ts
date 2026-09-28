import { getLCodeCopy, type UiLocale } from "@lcode/i18n";
import type { TuiEffortOption } from "@lcode/tui";
import type { CommandCenterApp } from "./types.js";

export async function listAppEffortOptions(
  app: CommandCenterApp,
): Promise<TuiEffortOption[] | undefined> {
  const levels = app.listThoughtLevels ? await app.listThoughtLevels() : undefined;
  return levels ? thoughtLevelsToEffortOptions(levels, app.getLocale?.()) : undefined;
}

export function thoughtLevelsToEffortOptions(
  levels: readonly string[],
  locale?: UiLocale,
): TuiEffortOption[] {
  const effortCopy = getLCodeCopy(locale).tui.effort;
  return levels.map((level) => ({
    id: level,
    label: effortLabel(level, effortCopy),
  }));
}

function effortLabel(level: string, effortCopy: { disabled: string; enabled: string }): string {
  if (level === "enabled") return effortCopy.enabled;
  if (level === "disabled") return effortCopy.disabled;
  return level;
}
