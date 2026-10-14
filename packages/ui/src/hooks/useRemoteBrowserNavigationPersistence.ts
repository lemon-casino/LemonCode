import { createContext, useCallback, useEffect, useRef, useState } from "react";
import type { AppSettings } from "@lcode/shared";
import type { IServiceAccessor } from "@lcode/services";
import { logger } from "@/logger.js";
import {
  useRemoteBrowserNavigationStore,
  type RemoteBrowserNavigationTarget,
} from "@/store/remoteBrowserNavigationStore.js";
import { useLCodeSessionStore } from "@/store/lcodeSessionStore.js";
import { isWorkspaceTab, type TabStore } from "@/store/tabStore.js";
import { restoreRemoteBrowserNavigation } from "./remoteBrowserNavigationRestore.js";

export const RemoteBrowserNavigationScopeContext = createContext<string | undefined>(undefined);

export function useRemoteBrowserNavigationPersistence({
  scope,
  services,
  tabStoreApi,
}: {
  scope?: string;
  services: IServiceAccessor;
  tabStoreApi: TabStore;
}) {
  const [hasEntered] = useState(() => useRemoteBrowserNavigationStore.getState().hasEntered);
  const [restored, setRestored] = useState(false);
  const generation = useRef(0);
  const mounted = useRef(true);
  const readFailed = useRef(false);
  const didRestore = useRef(false);
  const operation = useRef<Promise<void> | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
    };
  }, []);

  const enter = useCallback(() => {
    if (scope) useRemoteBrowserNavigationStore.getState().enter();
  }, [scope]);
  const restore = useCallback(
    async (settings: AppSettings) => {
      if (!scope || !mounted.current) return;
      if (operation.current) return operation.current;
      const current = ++generation.current;
      const isCurrent = () => mounted.current && generation.current === current;
      const target = useRemoteBrowserNavigationStore.getState().targets[scope] ?? null;
      // 启动恢复只消费一次；手动打开/关闭登录入口不能重新覆盖用户当前选择。
      operation.current = (async () => {
        try {
          await restoreRemoteBrowserNavigation({
            settings,
            target,
            services,
            tabStoreApi,
            isCurrent,
          });
          didRestore.current = true;
        } catch (error) {
          if (!isCurrent()) return;
          // 网络失败不是项目/会话被删除；本次落到新建任务，原轻绑定留到下次重试。
          readFailed.current = true;
          logger.warn("[remote-browser-navigation] 位置验证失败，保留记忆", { error });
          await restoreRemoteBrowserNavigation({
            settings,
            target: null,
            services,
            tabStoreApi,
            isCurrent,
          });
        }
      })();
      return operation.current;
    },
    [scope, services, tabStoreApi],
  );

  const beginRemembering = useCallback(() => {
    if (!scope || !mounted.current) return;
    // settingService 首读失败时也要在启动兜底结束后开启订阅，但不能清掉原位置。
    if (!didRestore.current) readFailed.current = true;
    setRestored(true);
  }, [scope]);

  useEffect(() => {
    if (!scope || !restored) return;
    function currentTarget(): RemoteBrowserNavigationTarget | null {
      const tabs = tabStoreApi.getState();
      const workspace = tabs.tabs.find(
        (tab) =>
          isWorkspaceTab(tab) &&
          (tab.workspaceIdentity?.trim() || tab.workspacePath) ===
            (tabs.activeWorkspaceIdentity?.trim() || tabs.activeWorkspacePath),
      );
      if (!workspace || !isWorkspaceTab(workspace)) return null;
      const taskId = useLCodeSessionStore
        .getState()
        .getWorkspaceState(workspace.workspacePath, workspace.workspaceIdentity).activeTaskId;
      return {
        workspacePath: workspace.workspacePath,
        taskId,
        ...(workspace.workspaceIdentity ? { workspaceIdentity: workspace.workspaceIdentity } : {}),
        ...(workspace.remoteSessionId ? { remoteSessionId: workspace.remoteSessionId } : {}),
        ...(workspace.workspacePurpose ? { workspacePurpose: workspace.workspacePurpose } : {}),
        ...(workspace.localProjectId ? { localProjectId: workspace.localProjectId } : {}),
      };
    }
    let previous = JSON.stringify(currentTarget());
    const remember = (force = false) => {
      const target = currentTarget();
      const signature = JSON.stringify(target);
      if (!target || (!force && signature === previous)) return;
      previous = signature;
      useRemoteBrowserNavigationStore.getState().remember(scope!, target);
    };
    if (!readFailed.current) remember(true);
    const disposeTabs = tabStoreApi.subscribe(() => remember());
    const disposeSessions = useLCodeSessionStore.subscribe((state, previousState) => {
      const tabs = tabStoreApi.getState();
      const key = tabs.activeWorkspaceIdentity?.trim() || tabs.activeWorkspacePath;
      if (
        key &&
        state.workspaces[key]?.activeTaskId !== previousState.workspaces[key]?.activeTaskId
      )
        remember();
    });
    return () => {
      disposeTabs();
      disposeSessions();
    };
  }, [restored, scope, tabStoreApi]);

  return { hasEntered, enter, restore, beginRemembering };
}
