import { shouldExposeE2EStoreBridge } from "@/lib/e2eStoreBridge.js";
import { useSkillStore } from "@/store/skillStore.js";
import { useSubagentsStore } from "@/store/subagentsStore.js";
import { useWhiteboardStore } from "@/store/whiteboardStore.js";
import { useLCodeSessionStore } from "@/store/lcodeSessionStore.js";

declare global {
  interface Window {
    __skillStoreE2E?: typeof useSkillStore;
    __subagentsStoreE2E?: typeof useSubagentsStore;
    __whiteboardStoreE2E?: typeof useWhiteboardStore;
    __lcodeSessionStoreE2E?: typeof useLCodeSessionStore;
  }
}

export function registerE2EStoreBridges() {
  if (!shouldExposeE2EStoreBridge()) {
    return;
  }

  // 部分 E2E 从设置页、错误页或特殊路由启动时，不一定自然 import
  // 对应 store 模块。renderer bootstrap 显式注册，保证 preflight 和测试注入稳定。
  window.__lcodeSessionStoreE2E = useLCodeSessionStore;
  window.__skillStoreE2E = useSkillStore;
  window.__subagentsStoreE2E = useSubagentsStore;
  window.__whiteboardStoreE2E = useWhiteboardStore;
}
