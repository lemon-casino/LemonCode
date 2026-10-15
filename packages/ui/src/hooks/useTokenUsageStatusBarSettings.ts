import { DEFAULT_TOKEN_USAGE_STATUS_BAR } from "@lcode/shared";
import { useSettings } from "./useSettingService.js";
import { useBaseWorkspaceServices } from "./useWorkspaceServices.js";

/** 状态栏是客户端界面偏好；远端 pane 也读同一个 base owner，避免跨主机切换时丢失设置。 */
export function useTokenUsageStatusBarSettings() {
  const settings = useSettings(useBaseWorkspaceServices());
  return {
    ...settings,
    preferences: settings.settings?.tokenUsageStatusBar ?? DEFAULT_TOKEN_USAGE_STATUS_BAR,
  };
}
