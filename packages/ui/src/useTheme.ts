import { useEffect, useState, useCallback } from "react";

export type Theme =
  | "light"
  | "dark"
  | "zai-light"
  | "zai-dark"
  | "sepia-light"
  | "midnight-blue"
  | "forest-dark"
  | "system";
export type ResolvedTheme = "light" | "dark";

/**
 * 主题明暗基底。"dynamic" 仅用于 system：真实基底由 matchMedia 实时解析，
 * 消费端不得把它当静态基底读取；静态主题的 base 即激活时呈现的明暗基底
 * （深基底主题激活时 documentElement 挂 dark + theme-<id>，浅基底只挂 theme-<id>）。
 */
export type ThemeBase = "light" | "dark" | "dynamic";

export interface ThemeOption {
  id: Theme;
  base: ThemeBase;
  /** 设置页入口的显示名 i18n key；侧栏入口按 id 派生（system 沿用 sidebar.settings.systemDefault）。 */
  labelKey: string;
  /** 三色小色板（底色/前景/主色），供 ThemeSwatch 纯展示使用；system 项由 ThemeSwatch 用对半分色表达动态。 */
  swatch: { bg: string; fg: string; primary: string };
}

const STORAGE_KEY = "zcode-theme";
const BROWSER_THEME_SURFACE_ATTRIBUTE = "data-zcode-browser-theme-surface";

// 合法主题与明暗基底的唯一注册表（spec: specs/ui-theme-modes.md）：
// 新增主题只允许改这里；白名单（isThemeValue）、暗色判定（resolveTheme）与
// 设置页/侧栏两个选择入口全部由本表派生，组件内禁止再散落新的主题字面量白名单。
// 顺序即用户可见展示顺序。
export const THEME_OPTIONS: readonly ThemeOption[] = [
  {
    id: "system",
    base: "dynamic",
    labelKey: "settings.themeMode.system",
    swatch: { bg: "#f8f8f8", fg: "#161616", primary: "#4099ff" },
  },
  {
    id: "zai-dark",
    base: "dark",
    labelKey: "settings.themeMode.zai-dark",
    swatch: { bg: "#161616", fg: "#f8f8f8", primary: "#4099ff" },
  },
  {
    id: "zai-light",
    base: "light",
    labelKey: "settings.themeMode.zai-light",
    swatch: { bg: "#f8f8f8", fg: "#0d0d0d", primary: "#0b7fff" },
  },
  {
    id: "sepia-light",
    base: "light",
    labelKey: "settings.themeMode.sepia-light",
    swatch: { bg: "#f6f1e7", fg: "#3f382e", primary: "#8a5a1e" },
  },
  {
    id: "midnight-blue",
    base: "dark",
    labelKey: "settings.themeMode.midnight-blue",
    swatch: { bg: "#0d1424", fg: "#e6ebf5", primary: "#5b9dff" },
  },
  {
    id: "forest-dark",
    base: "dark",
    labelKey: "settings.themeMode.forest-dark",
    swatch: { bg: "#101812", fg: "#d9e2d9", primary: "#7fbf8e" },
  },
];

function getSystemTheme(): ResolvedTheme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function resolveTheme(theme: Theme): ResolvedTheme {
  if (theme === "system") {
    return getSystemTheme();
  }

  // legacy light/dark 先归一成 zai 对再查注册表；归一后必然命中。
  // 未命中时按字面量兜底，避免未知值把暗色基底误判成亮色（下游 shiki/mermaid/原生标题栏都依赖这里）。
  const option = THEME_OPTIONS.find(
    (candidate) => candidate.id === normalizeThemePreference(theme),
  );
  if (option && option.base !== "dynamic") {
    return option.base;
  }
  return theme === "dark" ? "dark" : "light";
}

export function normalizeThemePreference(theme: Theme): Theme {
  if (theme === "dark") return "zai-dark";
  if (theme === "light") return "zai-light";
  return theme;
}

/**
 * 主题合法值唯一白名单：本地持久化值与跨窗口广播 payload 都必须经此校验。
 * 除注册表 6 个用户可见 id 外必须放行 legacy "light"/"dark"——旧版本持久化的
 * 合法值经 normalizeThemePreference 归一为 Zai 对（specs/ui-theme-modes.md 兼容性），
 * 否则旧 light 用户会被错误回落成默认 zai-dark。
 */
export function isThemeValue(value: unknown): value is Theme {
  return (
    value === "light" ||
    value === "dark" ||
    THEME_OPTIONS.some((option) => option.id === value)
  );
}

function setThemeMetaContent(name: "theme-color" | "color-scheme", content: string) {
  let meta = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = name;
    document.head.append(meta);
  }
  meta.content = content;
}

function syncBrowserThemeSurface(resolved: ResolvedTheme) {
  const root = document.documentElement;
  if (
    typeof root.hasAttribute !== "function" ||
    !root.hasAttribute(BROWSER_THEME_SURFACE_ATTRIBUTE)
  ) {
    return;
  }

  // Electron 为 vibrancy 保持透明根背景，但普通浏览器需要从文档根和标准 meta
  // 获得页面主题。只切换 React 的 dark class 会让浏览器工具栏、原生控件和 overscroll 留在旧主题。
  root.setAttribute(BROWSER_THEME_SURFACE_ATTRIBUTE, resolved);
  root.style.colorScheme = resolved;
  setThemeMetaContent("color-scheme", resolved);

  const background = getComputedStyle(root).getPropertyValue("--color-background").trim();
  if (background) {
    setThemeMetaContent("theme-color", background);
  }
}

// 激活态会挂到 documentElement 的 theme-<id> 类集合，类名与 styles.css 的变量块一一对应。
// applyTheme 泛化为「按基底 toggle dark + 清空并挂唯一 theme-<id>」：
// 浅基底主题只挂 theme-<id>（继承 :root/@theme 基底），深基底主题叠加 dark 基底。
const APPLIED_THEME_CLASS_NAMES = [
  "theme-zai-light",
  "theme-zai-dark",
  "theme-sepia-light",
  "theme-midnight-blue",
  "theme-forest-dark",
] as const;

export function applyTheme(theme: Theme) {
  const resolved = resolveTheme(theme);
  const appliedTheme =
    theme === "system"
      ? resolved === "dark"
        ? "zai-dark"
        : "zai-light"
      : normalizeThemePreference(theme);
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  // toggle 其余 theme-* 类为 false 等价于清空，避免切换主题时残留上一个主题的差量变量块。
  for (const className of APPLIED_THEME_CLASS_NAMES) {
    root.classList.toggle(className, className === `theme-${appliedTheme}`);
  }
  syncBrowserThemeSurface(resolved);
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    // 默认主题统一收敛到 Zai dark，避免旧 hook 兜底值和 Zustand store 默认值分叉。
    // 本地存储异常值经 isThemeValue 拦截后同样落回默认，不进入 state。
    return isThemeValue(saved) ? normalizeThemePreference(saved) : "zai-dark";
  });

  const setTheme = useCallback((t: Theme) => {
    const normalizedTheme = normalizeThemePreference(t);
    localStorage.setItem(STORAGE_KEY, normalizedTheme);
    setThemeState(normalizedTheme);
    applyTheme(normalizedTheme);
  }, []);

  // 初始化 + system 模式下监听系统偏好变化
  useEffect(() => {
    applyTheme(theme);

    if (theme !== "system") return;

    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => applyTheme("system");
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [theme]);

  return { theme, setTheme } as const;
}
