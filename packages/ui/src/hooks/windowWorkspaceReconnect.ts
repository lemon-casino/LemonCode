import {
  WINDOW_WORKSPACE_RECONNECT_TARGET_UNAVAILABLE,
  windowWorkspaceReconnectTargetSchema,
  windowWorkspaceReconnectRequestSchema,
  type WindowWorkspaceReconnectRequest,
} from "@lcode/shared";
import { isWorkspaceTab, type TabStore } from "@/store/tabStore.js";

export type DesktopWorkspaceReconnect = (
  key: string,
  options?: {
    cancelPending?: boolean;
    activateWorkspaceAfterReconnect?: boolean;
    showErrorToast?: boolean;
    throwOnFailure?: boolean;
  },
) => Promise<void>;

export function resolveWindowWorkspaceReconnectTarget(tabs: TabStore, key: string) {
  const tab = tabs
    .getState()
    .tabs.find((tab) => isWorkspaceTab(tab) && tab.workspaceIdentity?.trim() === key.trim());
  if (!tab || !isWorkspaceTab(tab)) throw new Error(WINDOW_WORKSPACE_RECONNECT_TARGET_UNAVAILABLE);
  return windowWorkspaceReconnectTargetSchema.parse({
    workspacePath: tab.workspacePath,
    workspaceIdentity: tab.workspaceIdentity,
  });
}

/** Desktop 是唯一重连执行者；不能用浏览器传来的 target 或同路径替代已有项目。 */
export async function executeDesktopWorkspaceReconnect(
  raw: WindowWorkspaceReconnectRequest,
  tabs: TabStore,
  reconnect: DesktopWorkspaceReconnect,
) {
  const request = windowWorkspaceReconnectRequestSchema.parse(raw);
  const target = resolveWindowWorkspaceReconnectTarget(tabs, request.workspaceIdentity);
  if (target.workspacePath !== request.workspacePath)
    throw new Error(WINDOW_WORKSPACE_RECONNECT_TARGET_UNAVAILABLE);
  await reconnect(target.workspaceIdentity, {
    activateWorkspaceAfterReconnect: false,
    showErrorToast: false,
    throwOnFailure: true,
  });
}
