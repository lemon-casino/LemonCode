import { applyTheme, isThemeValue } from "@lcode/ui/useTheme";
import { createRoot } from "react-dom/client";
import type { ResourceUsageSnapshot, StorageManagementBridge } from "@lcode/shared";
import "@lcode/ui/styles.css";
import {
  ResourceManagerApp,
  LCodeIntlProvider,
  applyUiFontSizePx,
  loadUiFontSizePx,
  subscribeToUiFontSizeStorageChanges,
} from "@lcode/ui";

declare global {
  interface Window {
    resourceManager?: {
      getSnapshot: () => Promise<ResourceUsageSnapshot>;
      setSamplingActive: (active: boolean) => void;
      storage?: StorageManagementBridge;
    };
  }
}

// 独立窗口只读取全局偏好并投影，不创建业务 store 或回写主题。
function applyResourceManagerTheme(): void {
  const saved = localStorage.getItem("lcode-theme") || localStorage.getItem("zcode-theme");
  applyTheme(isThemeValue(saved) ? saved : "zai-dark");
}
applyResourceManagerTheme();
window.addEventListener("storage", (event) => {
  if (event.key === "lcode-theme" || event.key === null) applyResourceManagerTheme();
});
// 原独立窗口只监听 storage，system 下 OS 变化不会产生 storage 事件。
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (localStorage.getItem("lcode-theme") === "system") applyResourceManagerTheme();
});
// 资源管理器不创建主窗口的 Zustand store，text-ui-* 无法自动获得持久化基准。
// 首屏前显式应用，运行中再由 storage 事件同步，且不改变 html font-size 或接入业务 Host。
applyUiFontSizePx(loadUiFontSizePx());
subscribeToUiFontSizeStorageChanges();

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    // 语言沿用主窗口写入 localStorage 的偏好；不接 settingService，避免独立窗口再起一份 RPC。
    <LCodeIntlProvider>
      <ResourceManagerApp
        setSamplingActive={window.resourceManager?.setSamplingActive}
        getSnapshot={
          window.resourceManager ? () => window.resourceManager!.getSnapshot() : undefined
        }
        storage={window.resourceManager?.storage}
      />
    </LCodeIntlProvider>,
  );
}
