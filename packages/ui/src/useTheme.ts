import { useEffect, useState, useCallback } from "react";

import {
  DEFAULT_THEME,
  THEME_STORAGE_KEY,
  THEME_OPTIONS,
  isThemeValue,
  normalizeThemePreference,
  resolveAppliedThemeOption,
  type Theme,
  type ResolvedTheme,
} from "./themeConfig.js";
export { THEME_OPTIONS, isThemeValue, normalizeThemePreference } from "./themeConfig.js";
export type { Theme, ResolvedTheme, ThemeBase, ThemeOption } from "./themeConfig.js";

const STORAGE_KEY = THEME_STORAGE_KEY;
const BROWSER_THEME_SURFACE_ATTRIBUTE = "data-lcode-browser-theme-surface";

function getSystemTheme(): ResolvedTheme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function resolveTheme(theme: Theme): ResolvedTheme {
  return resolveAppliedThemeOption(theme, theme === "system" && getSystemTheme() === "dark")
    .base as ResolvedTheme;
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
export function applyTheme(theme: Theme) {
  const option = resolveAppliedThemeOption(
    theme,
    theme === "system" && getSystemTheme() === "dark",
  );
  const resolved = option.base as ResolvedTheme;
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  // 首屏、运行时和独立窗口只按同一注册表清理/挂载，避免手写类列表漏掉新增主题。
  for (const candidate of THEME_OPTIONS) {
    if (candidate.base !== "dynamic") {
      root.classList.toggle(`theme-${candidate.id}`, candidate.id === option.id);
    }
  }
  root.style.colorScheme = resolved;
  // CSS 已加载后移除首屏种子，后续所有页面和浏览器 meta 读取真实语义变量。
  root.style.removeProperty("--lcode-bootstrap-bg");
  root.style.removeProperty("--lcode-bootstrap-fg");
  syncBrowserThemeSurface(resolved);
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    // 默认主题统一收敛到 Zai dark，避免旧 hook 兜底值和 Zustand store 默认值分叉。
    // 本地存储异常值经 isThemeValue 拦截后同样落回默认，不进入 state。
    return isThemeValue(saved) ? normalizeThemePreference(saved) : DEFAULT_THEME;
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
