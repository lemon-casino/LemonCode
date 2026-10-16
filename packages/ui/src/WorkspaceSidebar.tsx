import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { Blocks, CalendarClock, Search } from "lucide-react";
import type { Locale, RemoteTarget, UserInfo } from "@lcode/shared";
import { TID_AUTOMATIONS_OPEN, TID_SIDEBAR } from "@lcode/shared";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { NewTaskButtonGroup } from "@/NewTaskButtonGroup.js";
import { selectWorkspaceLCodeState, useLCodeSessionStore } from "@/store/lcodeSessionStore.js";
import { useLCodeStore } from "@/store/StoreProvider.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceReadOnly, isWorkspaceTab } from "@/store/tabStore.js";
import { setPendingSettingsSection } from "@/lib/settingsNavigation.js";
import { MobileRemoteControlPanel } from "@/settings/MobileRemoteControlPanel.js";
import { hasDesktopPlatformCapability } from "@/settings/settingsPageConfig.js";
import { useShortcutCommandLabel } from "@/shortcuts/useShortcutBindings.js";
import { isThemeValue, type Theme } from "@/useTheme.js";
import type { RemoteConnectionLogEntry } from "@/hooks/useRemoteConnectionLogs.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { WorkspaceFileTree } from "@/WorkspaceFileTree.js";
import { WorkspaceSidebarFooter } from "@/WorkspaceSidebarFooter.js";
import type { CreateTaskRequest } from "@/app-shell/types.js";
import { resolveWorktreeFileTarget } from "./worktreeFileTarget.js";
import { cn } from "@/components/lib/utils.js";
import { SidebarOrganizationProvider } from "@/hooks/useSidebarOrganization.js";
import { UnifiedSidebarTree } from "@/WorkspaceSidebar/UnifiedSidebarTree.js";
export { applyWorkspaceTriggerSelection } from "@/WorkspaceSidebar/workspaceSidebarSelection.js";
export { WorkspaceSidebarCollapsedRail } from "@/WorkspaceSidebar/WorkspaceSidebarCollapsedRail.js";
interface SidebarFileTreeTarget {
  workspacePath: string;
  workspaceName: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  revealPath?: string;
  temporaryExternalDirectory?: boolean;
}
export interface SidebarFileTreeOpenRequest {
  id: number;
  target: SidebarFileTreeTarget;
}
const EMPTY_RECONNECTING_REMOTE_WORKSPACE_LOGS_BY_WORKSPACE_KEY: Record<
  string,
  RemoteConnectionLogEntry[]
> = {};
export const WorkspaceSidebar = memo(function WorkspaceSidebarComponent({
  workspacePath,
  executionWorkspace: _executionWorkspace,
  executionBinding,
  workspaceRemoteSessionId,
  activePreviewPath,
  onSelectTask,
  onStartDraftInWorkspace,
  onOpenCodeViewer,
  onOpenBrowserUrl,
  fileTreeOpenRequest,
  onCreateTask,
  onCreateConversationTask,
  onOpenFolderFromWorkspaceMenu,
  onRemoveLocalProject,
  onOpenRemoteWorkspace,
  theme,
  onConnectRemote: _onConnectRemote,
  onSelectRemoteProject: _onSelectRemoteProject,
  onCancelRemoteProject,
  onReconnectRemoteWorkspace,
  onLogout,
  onLogin,
  user,
  reconnectingRemoteWorkspaceKeys,
  remoteWorkspaceErrorByWorkspaceKey,
  reconnectingRemoteWorkspaceLogsByWorkspaceKey = EMPTY_RECONNECTING_REMOTE_WORKSPACE_LOGS_BY_WORKSPACE_KEY,
  isDesktop = false,
  isMacDesktop = false,
  isWindowsDesktop = false,
  isSidebarVisible: _isSidebarVisible = true,
  onToggleSidebar: _onToggleSidebar,
  toggleSidebarShortcutLabel: _toggleSidebarShortcutLabel,
  canGoBack: _canGoBack = false,
  canGoForward: _canGoForward = false,
  onGoBack: _onGoBack,
  onGoForward: _onGoForward,
  goBackShortcutLabel: _goBackShortcutLabel,
  goForwardShortcutLabel: _goForwardShortcutLabel,
  onOpenCommandCenter,
  onOpenAutomations,
  onOpenPluginStore,
  automationsActive = false,
  pluginStoreActive = false,
  onFileTreeOpenChange,
  hideTopSpacer = false,
}: {
  workspacePath: string;
  executionWorkspace?: import("@lcode/shared").LCodeWorkspaceRef | null;
  executionBinding?: import("@lcode/services").WorktreeBinding;
  workspaceRemoteSessionId?: string;
  activePreviewPath?: string | null;
  onSelectTask: (
    targetWorkspacePath: string,
    taskId: string,
    targetWorkspaceIdentity?: string,
    targetRemoteSessionId?: string,
    expectedUnreadAt?: number,
  ) => void;
  onStartDraftInWorkspace: (targetWorkspacePath: string, targetWorkspaceIdentity?: string) => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onOpenBrowserUrl?: (url: string) => void;
  fileTreeOpenRequest?: SidebarFileTreeOpenRequest | null;
  onCreateTask: (request?: CreateTaskRequest) => void;
  onCreateConversationTask: () => void;
  onOpenFolderFromWorkspaceMenu: () => void;
  onRemoveLocalProject?: (
    request: import("@lcode/shared").LocalProjectRemoveRequest,
  ) => Promise<void>;
  onOpenRemoteWorkspace?: () => void;
  theme: Theme;
  onConnectRemote: (options: RemoteTarget, requestId?: string) => Promise<string>;
  onSelectRemoteProject: (
    sessionId: string,
    path: string,
    localWorkspacePath?: string,
  ) => Promise<void>;
  onCancelRemoteProject: (sessionId: string) => Promise<void>;
  onReconnectRemoteWorkspace: (
    workspaceKey: string,
    options?: { cancelPending?: boolean },
  ) => Promise<void>;
  onLogout?: () => void;
  onLogin?: () => void;
  user?: UserInfo | null;
  reconnectingRemoteWorkspaceKeys: string[];
  remoteWorkspaceErrorByWorkspaceKey: Record<string, string>;
  reconnectingRemoteWorkspaceLogsByWorkspaceKey?: Record<string, RemoteConnectionLogEntry[]>;
  isDesktop?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  isSidebarVisible?: boolean;
  onToggleSidebar?: () => void;
  toggleSidebarShortcutLabel?: string;
  canGoBack?: boolean;
  canGoForward?: boolean;
  onGoBack?: () => void;
  onGoForward?: () => void;
  goBackShortcutLabel?: string;
  goForwardShortcutLabel?: string;
  onOpenCommandCenter: () => void;
  onOpenAutomations?: () => void;
  onOpenPluginStore?: () => void;
  automationsActive?: boolean;
  pluginStoreActive?: boolean;
  onFileTreeOpenChange?: (open: boolean) => void;
  hideTopSpacer?: boolean;
}) {
  const { intl, localePreference, setLocalePreference } = useLCodeIntl();
  const tabs = useTabStore((state) => state.tabs);
  const activeTabId = useTabStore((state) => state.activeTabId);
  const workspaceIdentity = useMemo(() => {
    const tab = tabs.find((item) => item.id === activeTabId);
    return tab && isWorkspaceTab(tab) && tab.workspacePath === workspacePath
      ? tab.workspaceIdentity
      : undefined;
  }, [tabs, activeTabId, workspacePath]);
  const workspaceReadOnly = useTabStore((state) =>
    isWorkspaceReadOnly(state, workspacePath, workspaceIdentity),
  );
  const openSettingsTab = useTabStore((state) => state.openSettingsTab);
  const setTheme = useLCodeStore((state) => state.setTheme);
  const commandCenterShortcutLabel = useShortcutCommandLabel("openCommandCenter");
  const [isFileTreeOpen, setIsFileTreeOpen] = useState(false);
  const [fileTreeTarget, setFileTreeTarget] = useState<SidebarFileTreeTarget | null>(null);
  const resolvedFileTreeTarget = fileTreeTarget
    ? resolveWorktreeFileTarget(fileTreeTarget, executionBinding)
    : null;
  const activeTaskId = useLCodeSessionStore(
    (state) => selectWorkspaceLCodeState(state, workspacePath, workspaceIdentity).activeTaskId,
  );
  useEffect(() => {
    if (fileTreeOpenRequest) {
      setFileTreeTarget(fileTreeOpenRequest.target);
      setIsFileTreeOpen(true);
    }
  }, [fileTreeOpenRequest]);
  useEffect(() => {
    onFileTreeOpenChange?.(isFileTreeOpen);
  }, [isFileTreeOpen, onFileTreeOpenChange]);
  useEffect(() => () => onFileTreeOpenChange?.(false), [onFileTreeOpenChange]);
  const handleOpenFileTree = useCallback((target: SidebarFileTreeTarget) => {
    setFileTreeTarget(target);
    setIsFileTreeOpen(true);
  }, []);
  const openRemoteControlSettings = () => {
    setPendingSettingsSection("remoteControl");
    openSettingsTab();
  };
  const showRemoteControlFooterEntry = hasDesktopPlatformCapability({
    isDesktop,
    isMacDesktop,
    isWindowsDesktop,
  });
  const localeMenuValue = localePreference === "system" ? "system" : localePreference;
  const handleThemeChange = (value: string) => {
    if (isThemeValue(value)) setTheme(value);
  };
  const handleLocaleChange = (value: string) => {
    if (value === "system" || value === "zh-CN" || value === "en-US")
      setLocalePreference(value as Locale | "system");
  };
  return (
    <aside data-testid={TID_SIDEBAR} className="flex h-full flex-col overflow-hidden">
      <div className={cn("h-12 shrink-0 [app-region:drag]", hideTopSpacer && "hidden")} />
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div
          className={cn(
            "absolute inset-0 flex min-h-0 flex-col transition-transform duration-200 ease-out",
            isFileTreeOpen && "-translate-x-full pointer-events-none",
          )}
          aria-hidden={isFileTreeOpen}
          inert={isFileTreeOpen ? true : undefined}
        >
          <div className={cn("flex flex-col gap-1 px-2", isWindowsDesktop ? "py-2" : "py-3")}>
            <ControlHintTooltip
              title={
                workspaceReadOnly
                  ? intl.formatMessage({ id: "workspaceSidebar.unavailableLocalDirectory" })
                  : undefined
              }
            >
              <div>
                <NewTaskButtonGroup
                  disabled={workspaceReadOnly}
                  onCreateTask={() => {
                    if (!workspaceReadOnly) onCreateTask({ createSource: "project" });
                  }}
                />
              </div>
            </ControlHintTooltip>
            <Button
              variant="ghost"
              onClick={onOpenCommandCenter}
              data-icon="inline-start"
              size="lg"
              className="w-full justify-start gap-2 text-foreground hover:bg-surface-hover hover:text-foreground"
            >
              <Search className="size-4" />
              <span className="min-w-0 flex-1 truncate text-left">
                {intl.formatMessage({ id: "commandCenter.open" })}
              </span>
              <span className="ml-auto shrink-0 text-ui-xs font-normal text-foreground-subtlest">
                {commandCenterShortcutLabel}
              </span>
            </Button>
            <Button
              variant="ghost"
              onClick={onOpenAutomations}
              data-icon="inline-start"
              data-testid={TID_AUTOMATIONS_OPEN}
              size="lg"
              aria-pressed={automationsActive}
              className={cn(
                "w-full justify-start gap-2 text-foreground hover:bg-surface-hover hover:text-foreground",
                automationsActive && "bg-selected",
              )}
            >
              <CalendarClock className="size-4" />
              {intl.formatMessage({ id: "workspace.openScheduledSettings" })}
            </Button>
            <Button
              variant="ghost"
              onClick={onOpenPluginStore}
              data-icon="inline-start"
              data-testid="plugin-store-sidebar-open"
              size="lg"
              aria-pressed={pluginStoreActive}
              className={cn(
                "w-full justify-start gap-2 text-foreground hover:bg-surface-hover hover:text-foreground",
                pluginStoreActive && "bg-selected",
              )}
            >
              <Blocks className="size-4" />
              {intl.formatMessage({ id: "workspace.openPluginsSettings" })}
            </Button>
          </div>
          <SidebarOrganizationProvider isDesktop={isDesktop || isMacDesktop || isWindowsDesktop}>
            <UnifiedSidebarTree
              workspacePath={workspacePath}
              workspaceIdentity={workspaceIdentity}
              activeTaskId={activeTaskId}
              onSelectTask={onSelectTask}
              onStartDraftInWorkspace={onStartDraftInWorkspace}
              onCreateTask={onCreateTask}
              onCreateConversationTask={onCreateConversationTask}
              onOpenFolderFromWorkspaceMenu={onOpenFolderFromWorkspaceMenu}
              onOpenRemoteWorkspace={onOpenRemoteWorkspace}
              onRemoveLocalProject={onRemoveLocalProject}
              onReconnectRemoteWorkspace={onReconnectRemoteWorkspace}
              onCancelRemoteProject={onCancelRemoteProject}
              reconnectingRemoteWorkspaceKeys={reconnectingRemoteWorkspaceKeys}
              remoteWorkspaceErrorByWorkspaceKey={remoteWorkspaceErrorByWorkspaceKey}
              reconnectingRemoteWorkspaceLogsByWorkspaceKey={
                reconnectingRemoteWorkspaceLogsByWorkspaceKey
              }
              onOpenFileTree={handleOpenFileTree}
            />
          </SidebarOrganizationProvider>
          <WorkspaceSidebarFooter
            className="pr-3"
            theme={theme}
            localeMenuValue={localeMenuValue}
            onLocaleChange={handleLocaleChange}
            onThemeChange={handleThemeChange}
            onSettingsButtonClick={openSettingsTab}
            remoteControlPanel={
              showRemoteControlFooterEntry ? (
                <MobileRemoteControlPanel
                  mirrorWorkspace={{
                    remoteSessionId: workspaceRemoteSessionId,
                    workspacePath,
                    workspaceIdentity,
                  }}
                  onOpenSettings={openRemoteControlSettings}
                />
              ) : undefined
            }
            onUsageClick={openSettingsTab}
            onLogin={onLogin}
            onLogout={onLogout}
            user={user}
            workspacePath={workspacePath}
            workspaceIdentity={workspaceIdentity}
            workspaceRemoteSessionId={workspaceRemoteSessionId}
            activeTaskId={activeTaskId}
            isDesktop={isDesktop}
          />
        </div>
        <div
          className={cn(
            "absolute inset-0 transition-transform duration-200 ease-out",
            isFileTreeOpen ? "translate-x-0" : "translate-x-full pointer-events-none",
          )}
          aria-hidden={!isFileTreeOpen}
          inert={!isFileTreeOpen ? true : undefined}
        >
          {/* 文件目标来自显式浏览请求；冷会话 readSession 失败会令执行目录为空，
              旧门禁却同时隐藏任务列表和文件树（含返回按钮），只能靠新建任务解锁。
              目录访问与错误展示由目标 scope 的文件服务负责，不能依赖当前会话恢复。 */}
          {resolvedFileTreeTarget ? (
            <WorkspaceFileTree
              workspacePath={resolvedFileTreeTarget.workspacePath}
              workspaceName={resolvedFileTreeTarget.workspaceName}
              workspaceIdentity={resolvedFileTreeTarget.workspaceIdentity}
              workspaceRemoteSessionId={resolvedFileTreeTarget.workspaceRemoteSessionId}
              revealPath={resolvedFileTreeTarget.revealPath}
              temporaryExternalDirectory={resolvedFileTreeTarget.temporaryExternalDirectory}
              canOpenLocalFileManager={isDesktop}
              activePreviewPath={activePreviewPath}
              onClose={() => setIsFileTreeOpen(false)}
              onOpenBrowserUrl={isDesktop ? onOpenBrowserUrl : undefined}
              onOpenPreview={(source) => {
                // 文件树可以查看非当前 workspace 的文件。
                // 预览 source 携带 workspace 作用域，PreviewPane 才能用正确 host 读取远程文件；
                // 同时不切换当前 workspace，避免"Add to chat"丢给错误的 composer。
                onOpenCodeViewer?.({
                  ...source,
                  workspacePath: resolvedFileTreeTarget.workspacePath,
                  workspaceIdentity: resolvedFileTreeTarget.workspaceIdentity,
                  workspaceRemoteSessionId: resolvedFileTreeTarget.workspaceRemoteSessionId,
                });
              }}
            />
          ) : null}
        </div>
      </div>
    </aside>
  );
});
