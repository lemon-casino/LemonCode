import { createRoot } from "react-dom/client";
import type { ResourceUsageSnapshot, StorageManagementBridge } from "@zcode/shared";
import "@zcode/ui/styles.css";
import {
  ResourceManagerApp,
  ZCodeIntlProvider,
  applyUiFontSizePx,
  loadUiFontSizePx,
  subscribeToUiFontSizeStorageChanges,
} from "@zcode/ui";

declare global {
  interface Window {
    resourceManager?: {
      getSnapshot: () => Promise<ResourceUsageSnapshot>;
      setSamplingActive: (active: boolean) => void;
      storage?: StorageManagementBridge;
    };
  }
}

// 主题 id → 明暗基底：与 useTheme.ts THEME_OPTIONS 注册表保持同步的本地引导副本
// （独立窗口不建 store、不走广播链路，自带最小解析逻辑；新增主题需同步此处）。
const APPLIED_THEME_BASES = {
  "zai-light": "light",
  "zai-dark": "dark",
  "sepia-light": "light",
  "midnight-blue": "dark",
  "forest-dark": "dark",
} as const;

type AppliedTheme = keyof typeof APPLIED_THEME_BASES;

function isAppliedTheme(value: string): value is AppliedTheme {
  return value in APPLIED_THEME_BASES;
}

/** 把 localStorage 的原始主题偏好（含 legacy light/dark/system）归一为可挂载的激活主题。 */
function resolveAppliedTheme(savedTheme: string): AppliedTheme {
  if (savedTheme === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "zai-dark" : "zai-light";
  }
  if (savedTheme === "dark") return "zai-dark";
  if (savedTheme === "light") return "zai-light";
  // localStorage 可能被手改或旧版本污染：非法值回落默认 zai-dark，与主窗口 store 行为一致。
  return isAppliedTheme(savedTheme) ? savedTheme : "zai-dark";
}

function applyResourceManagerTheme(): void {
  const appliedTheme = resolveAppliedTheme(localStorage.getItem("zcode-theme") ?? "zai-dark");
  const root = document.documentElement;
  root.classList.toggle("dark", APPLIED_THEME_BASES[appliedTheme] === "dark");
  // toggle 其余 theme-* 为 false 等价清空，防止残留上一个主题的差量变量块。
  for (const themeId of Object.keys(APPLIED_THEME_BASES)) {
    root.classList.toggle(`theme-${themeId}`, themeId === appliedTheme);
  }
}

applyResourceManagerTheme();
// 资源管理器窗口不经过主窗口的广播链路（不建 store、不接 broadcastService），
// 但主窗口 setTheme 会写 localStorage；这里补 storage 监听跟随主窗口的主题切换，
// 否则独立窗口将持续停留打开时的旧主题，无法满足「与主窗口主题一致」。
window.addEventListener("storage", (event) => {
  if (event.key === "zcode-theme") {
    applyResourceManagerTheme();
  }
});
// 资源管理器不创建主窗口的 Zustand store，text-ui-* 无法自动获得持久化基准。
// 首屏前显式应用，运行中再由 storage 事件同步，且不改变 html font-size 或接入业务 Host。
applyUiFontSizePx(loadUiFontSizePx());
subscribeToUiFontSizeStorageChanges();

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    // 语言沿用主窗口写入 localStorage 的偏好；不接 settingService，避免独立窗口再起一份 RPC。
    <ZCodeIntlProvider>
      <ResourceManagerApp
        setSamplingActive={window.resourceManager?.setSamplingActive}
        getSnapshot={
          window.resourceManager ? () => window.resourceManager!.getSnapshot() : undefined
        }
        storage={window.resourceManager?.storage}
      />
    </ZCodeIntlProvider>,
  );
}
