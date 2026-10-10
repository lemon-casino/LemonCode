import {
  DEFAULT_THEME,
  isThemeValue,
  normalizeThemePreference,
  type Theme,
} from "@lcode/ui/theme-config";

export const WEB_DEFAULT_THEME: Theme = DEFAULT_THEME;
export function resolveWebInitialTheme({
  storedTheme,
  defaultTheme = WEB_DEFAULT_THEME,
}: {
  storedTheme?: string | null;
  defaultTheme?: Theme;
}): Theme {
  return normalizeThemePreference(isThemeValue(storedTheme) ? storedTheme : defaultTheme);
}
