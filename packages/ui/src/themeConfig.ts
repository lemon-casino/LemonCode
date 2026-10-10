/** 全局主题事实源：首屏引导、设置、持久化校验和 DOM 投影共用，不依赖 React。 */
export type Theme =
  | "light"
  | "dark"
  | "zai-light"
  | "zai-dark"
  | "sepia-light"
  | "midnight-blue"
  | "forest-dark"
  | "cinnabar"
  | "inkpurple"
  | "system";
export type ResolvedTheme = "light" | "dark";
export type ThemeBase = ResolvedTheme | "dynamic";
export interface ThemeOption {
  id: Theme;
  base: ThemeBase;
  labelKey: string;
  swatch: { bg: string; fg: string; primary: string };
}

export const DEFAULT_THEME: Theme = "zai-dark";
export const THEME_STORAGE_KEY = "lcode-theme";
export const THEME_OPTIONS: readonly ThemeOption[] = [
  {
    id: "system",
    base: "dynamic",
    labelKey: "settings.themeMode.system",
    swatch: { bg: "#f8fafc", fg: "#0c0c0e", primary: "#8a99dd" },
  },
  {
    id: "zai-dark",
    base: "dark",
    labelKey: "settings.themeMode.zai-dark",
    swatch: { bg: "#0c0c0e", fg: "#fafafa", primary: "#8a99dd" },
  },
  {
    id: "zai-light",
    base: "light",
    labelKey: "settings.themeMode.zai-light",
    swatch: { bg: "#f8fafc", fg: "#1e293b", primary: "#1e293b" },
  },
  {
    id: "sepia-light",
    base: "light",
    labelKey: "settings.themeMode.sepia-light",
    swatch: { bg: "#faf7f2", fg: "#44392c", primary: "#7a6349" },
  },
  {
    id: "midnight-blue",
    base: "light",
    labelKey: "settings.themeMode.midnight-blue",
    swatch: { bg: "#eef7ff", fg: "#102d44", primary: "#0c6098" },
  },
  {
    id: "forest-dark",
    base: "light",
    labelKey: "settings.themeMode.forest-dark",
    swatch: { bg: "#f1f7ed", fg: "#1d3321", primary: "#356e3b" },
  },
  {
    id: "cinnabar",
    base: "light",
    labelKey: "settings.themeMode.cinnabar",
    swatch: { bg: "#fff3ef", fg: "#3e1f1a", primary: "#b83a2f" },
  },
  {
    id: "inkpurple",
    base: "dark",
    labelKey: "settings.themeMode.inkpurple",
    swatch: { bg: "#141019", fg: "#f5effa", primary: "#a78bfa" },
  },
];

export function normalizeThemePreference(theme: Theme): Theme {
  if (theme === "dark") return "zai-dark";
  if (theme === "light") return "zai-light";
  return theme;
}

export function isThemeValue(value: unknown): value is Theme {
  return (
    value === "light" || value === "dark" || THEME_OPTIONS.some((option) => option.id === value)
  );
}

/** 显式选择只按注册表归类；仅 system 读取系统明暗。非法值与旧版本保持一致回落默认。 */
export function resolveAppliedThemeOption(value: unknown, systemDark: boolean): ThemeOption {
  const preference = isThemeValue(value) ? normalizeThemePreference(value) : DEFAULT_THEME;
  const id = preference === "system" ? (systemDark ? "zai-dark" : "zai-light") : preference;
  return THEME_OPTIONS.find((option) => option.id === id)!;
}

/** Vite 在 dev/build 都内联同一注册表与解析函数，避免新增主题后 HTML 首屏白名单漂移。 */
export function createThemeBootstrapScript(): string {
  return `(() => {
    const THEME_OPTIONS = ${JSON.stringify(THEME_OPTIONS)};
    const DEFAULT_THEME = ${JSON.stringify(DEFAULT_THEME)};
    const normalizeThemePreference = ${normalizeThemePreference.toString()};
    const isThemeValue = ${isThemeValue.toString()};
    const resolveAppliedThemeOption = ${resolveAppliedThemeOption.toString()};
    let saved = DEFAULT_THEME;
    try {
      saved = localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)}) || localStorage.getItem("zcode-theme") || (/^\\/(?:cn\\/)?share(?:\\/|$)/.test(location.pathname) ? "zai-light" : DEFAULT_THEME);
    } catch { /* 本地存储不可用时保留产品默认主题。 */ }
    const option = resolveAppliedThemeOption(saved, !!window.matchMedia?.("(prefers-color-scheme: dark)").matches);
    const root = document.documentElement;
    root.classList.toggle("dark", option.base === "dark");
    for (const theme of THEME_OPTIONS) {
      if (theme.base !== "dynamic") root.classList.toggle("theme-" + theme.id, theme.id === option.id);
    }
    root.setAttribute("data-lcode-bootstrap-theme", option.base);
    root.setAttribute("data-lcode-browser-theme-surface", option.base);
    root.style.colorScheme = option.base;
    root.style.setProperty("--lcode-bootstrap-bg", option.swatch.bg);
    root.style.setProperty("--lcode-bootstrap-fg", option.swatch.fg);
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", option.swatch.bg);
    document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", option.base);
  })();`;
}
