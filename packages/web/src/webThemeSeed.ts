// 与 useTheme.ts 的 THEME_OPTIONS 注册表保持同步的种子白名单（新增主题需同步此处）。
type WebThemeSeed =
  | "light"
  | "dark"
  | "zai-light"
  | "zai-dark"
  | "sepia-light"
  | "midnight-blue"
  | "forest-dark"
  | "system";

export const WEB_DEFAULT_THEME: WebThemeSeed = "zai-dark";

function isWebThemeSeed(value: unknown): value is WebThemeSeed {
  return (
    value === "light" ||
    value === "dark" ||
    value === "zai-light" ||
    value === "zai-dark" ||
    value === "sepia-light" ||
    value === "midnight-blue" ||
    value === "forest-dark" ||
    value === "system"
  );
}

function normalizeWebThemeSeed(theme: WebThemeSeed): WebThemeSeed {
  if (theme === "dark") return "zai-dark";
  if (theme === "light") return "zai-light";
  return theme;
}

export function resolveWebInitialTheme({
  storedTheme,
  defaultTheme = WEB_DEFAULT_THEME,
}: {
  storedTheme?: string | null;
  defaultTheme?: WebThemeSeed;
}): WebThemeSeed {
  if (isWebThemeSeed(storedTheme)) {
    return normalizeWebThemeSeed(storedTheme);
  }

  return normalizeWebThemeSeed(defaultTheme);
}
