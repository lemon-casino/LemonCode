import { useEffect, useState, type ReactNode } from "react";
import { MantineProvider } from "@mantine/core";

/**
 * controls 适配层专用的 Mantine Provider 桥接。
 *
 * 挂载方式是「适配器自包含」：每个 Mantine 控件适配器内部自带本 Provider，
 * 宿主（WhiteboardPane / WorkspaceShellLayout / web fixture）不需要、也不应该
 * 在根部挂全局 MantineProvider。普通 Radix 基础控件（components/ui/*）不得
 * 因此被包进 Mantine 上下文。
 *
 * 明暗唯一事实源仍是现有链路：themeConfig 注册表（themeConfig.ts）+
 * store 投影（store/index.ts setTheme）+ applyTheme 写入 documentElement 的
 * dark class（useTheme.ts）。本 Provider 只观察这个 DOM 事实并派生
 * forceColorScheme，不新增持久化、不新增颜色模式 store。
 */

// Mantine 默认 manager 会读写 localStorage（mantine-color-scheme-value）。
// 主题持久化已由本仓 theme 系统承担，这里换成只读 no-op：get 直接从
// documentElement 的 dark class 推导，让首帧 data-mantine-color-scheme 就与
// 宿主主题一致；set/clear/subscribe 均不落地任何存储。
const readOnlyColorSchemeManager = {
  get: () =>
    typeof document !== "undefined" && document.documentElement.classList.contains("dark")
      ? ("dark" as const)
      : ("light" as const),
  set: () => {},
  subscribe: () => {},
  unsubscribe: () => {},
  clear: () => {},
};

function useObservedColorScheme(): "light" | "dark" {
  const [colorScheme, setColorScheme] = useState<"light" | "dark">(() =>
    document.documentElement.classList.contains("dark") ? "dark" : "light",
  );

  useEffect(() => {
    const root = document.documentElement;
    // 观察 dark class 而非订阅 store 的 theme：显式切换、system 模式下的系统偏好
    // 变化、跨窗口广播最终都经 applyTheme 落到 documentElement；而 system 模式下
    // store 的 theme 值保持 "system"，OS 切换不会触发 store 更新，订阅会漏掉该路径。
    const observer = new MutationObserver(() => {
      setColorScheme(root.classList.contains("dark") ? "dark" : "light");
    });
    observer.observe(root, { attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  return colorScheme;
}

export function MantineControlsProvider({ children }: { children: ReactNode }) {
  const colorScheme = useObservedColorScheme();

  return (
    <MantineProvider
      // forceColorScheme 生效时 MantineProvider 忽略 colorSchemeManager 与
      // defaultColorScheme（MantineProvider.d.ts），Mantine 自身不持久化主题；
      // colorSchemeManager 只影响首帧 data-mantine-color-scheme 的初值。
      forceColorScheme={colorScheme}
      colorSchemeManager={readOnlyColorSchemeManager}
    >
      {children}
    </MantineProvider>
  );
}
