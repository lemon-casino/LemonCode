import type { UiThemeMode, UiThemePreference } from "@lcode/contracts";
import { BUILTIN_TUI_THEMES, DEFAULT_TUI_THEME_MODE } from "./defaults.js";
import type { TuiThemeTokens } from "./types.js";

let activeThemeMode: UiThemeMode = DEFAULT_TUI_THEME_MODE;

export function activeTuiTheme(mode: UiThemeMode = activeThemeMode): TuiThemeTokens {
  return BUILTIN_TUI_THEMES[mode];
}

export function getActiveTuiThemeMode(): UiThemeMode {
  return activeThemeMode;
}

export function setActiveTuiThemeMode(mode: UiThemeMode): void {
  activeThemeMode = mode;
}

export function resolveTuiThemeMode(
  preference: UiThemePreference | undefined,
  terminalThemeMode: UiThemeMode | null | undefined,
): UiThemeMode {
  if (preference === "dark" || preference === "light") return preference;
  return terminalThemeMode ?? DEFAULT_TUI_THEME_MODE;
}

export function isTuiThemeMode(value: unknown): value is UiThemeMode {
  return value === "dark" || value === "light";
}

