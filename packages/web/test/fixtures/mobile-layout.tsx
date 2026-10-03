/// <reference types="vite/client" />
import { useRef, useState, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import type { GitPaneRepositoryState } from "@/hooks/useGitRepository.js";
import { DesktopWindowFrame } from "@/DesktopWindowFrame.js";
import { DesktopTopOverlay } from "@/DesktopTopOverlay.js";
import { WorkspaceHeader } from "@/WorkspaceHeader.js";
import {
  WorkspaceShellSurface,
  WorkspaceSidebarPanel,
  WorkspaceContentColumn,
  WorkspaceBodyPanelGroup,
  WorkspaceDrawerBackdrop,
  WorkspaceTopNavigation,
} from "@/app-shell/WorkspaceShellSurface.js";
import { WorkspacePanelDrawer } from "@/app-shell/WorkspacePanelDrawer.js";
import { AnimatedSidePanePanel } from "@/app-shell/AnimatedSidePanePanel.js";
import { AnimatedTerminalPanel } from "@/app-shell/AnimatedTerminalPanel.js";
import { useAnimatedResizablePanel } from "@/app-shell/useAnimatedResizablePanel.js";
import { ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable.js";
import { useAppPanels } from "@/hooks/useAppPanels.js";
import { useNarrowWebLayout } from "@/hooks/useNarrowWebLayout.js";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { LCodeIntlProvider, useLCodeIntl } from "@/i18n/IntlProvider.js";
import { StoreProvider } from "@/store/StoreProvider.js";
import { TabStoreProvider } from "@/store/TabStoreProvider.js";
import { DiffsWorkerPoolProvider } from "@/root/DiffsWorkerPoolProvider.js";
import { SettingsPage } from "@/SettingsPage.js";
import { setPendingSettingsSection } from "@/lib/settingsNavigation.js";
import { connectProviderSettingsSnapshot } from "@/lib/providerSettingsSnapshot.js";
import { V4ConversationContext } from "@/v4/V4ConversationContext.js";
import { Controls, FixtureConversation, RowsFixture } from "./mobile-layout-content.js";
import { FocusScrollProbe } from "./mobile-layout-focus-scroll.js";
import {
  action,
  conversationContext,
  gitSummary,
  layer,
  noop,
  platform,
  services,
  workspacePath,
} from "./mobile-layout-data.js";
import "@lcode/ui/styles.css";
import "@xterm/xterm/css/xterm.css";

const COLUMN_IDS = ["conversation", "terminal"];
const WORKSPACE_KEYS = [workspacePath];
const gitState: GitPaneRepositoryState = {
  workspaceKey: workspacePath,
  summary: gitSummary,
  identity: {
    userName: "Fixture",
    userEmail: "fixture@example.invalid",
    nameSource: "local",
    emailSource: "local",
  },
  placeholder: { enabled: false },
  loading: false,
  error: null,
  revision: 1,
  sourceOptions: [],
  datasets: {} as GitPaneRepositoryState["datasets"],
};
const providerConnection = connectProviderSettingsSnapshot(services.providerSettingsService);
void providerConnection.ready;
const query = new URLSearchParams(location.search);

function Fixture() {
  const { intl } = useLCodeIntl();
  const narrow = useNarrowWebLayout(false);
  const panels = useAppPanels({
    workspaceAbsPath: workspacePath,
    activeTaskId: "mobile-fixture-session",
    sidePaneOwnerId: "mobile-fixture-session",
    isDesktop: false,
    isNarrowWebLayout: narrow,
    defaultWhiteboardNamePrefix: "Fixture",
    platform,
  });
  const [screen, setScreen] = useState(query.get("view") ?? "shell");
  const sidebarTrigger = useRef<HTMLButtonElement>(null);
  const sideTrigger = useRef<HTMLButtonElement>(null);
  const drawerOpen = narrow && (panels.isSidebarVisible || !panels.isSidePaneCollapsed);
  const side = useAnimatedResizablePanel({
    open: !panels.isSidePaneCollapsed,
    expandedSize: "48%",
    rememberExpandedSize: true,
    resizeOnInitialVisibleMount: false,
    resizeEnabled: !narrow,
  });
  const terminal = useAnimatedResizablePanel({
    open: panels.isTerminalOpen,
    expandedSize: "30%",
    rememberExpandedSize: true,
  });
  const openPreview = () =>
    panels.handleOpenCodeViewer({
      type: "text",
      title: "Fixture retained preview",
      language: "markdown",
      content:
        "# Retained preview\n\n" +
        Array.from(
          { length: 50 },
          (_, index) => `Line ${index + 1}: deterministic preview content.`,
        ).join("\n\n"),
    });
  const showSettings = () => {
    setPendingSettingsSection("general");
    setScreen("settings");
    panels.handleCloseSidebar();
    if (!panels.isSidePaneCollapsed) panels.handleCloseSidePane();
  };
  return (
    <>
      <FocusScrollProbe />
      <div hidden={screen !== "shell"} inert={screen !== "shell" ? true : undefined}>
        <DesktopWindowFrame title="Mobile production layout fixture">
          <WorkspaceShellSurface
            isNarrowWebLayout={narrow}
            isNativeDesktop={false}
            style={
              {
                "--workspace-sidebar-panel-width": panels.isSidebarVisible ? "264px" : "0px",
                "--workspace-panel-radius": "12px",
              } as CSSProperties
            }
          >
            <WorkspaceSidebarPanel
              id="fixture-sidebar"
              isNarrowWebLayout={narrow}
              open={panels.isSidebarVisible}
            >
              <WorkspacePanelDrawer
                id="fixture-navigation"
                enabled={narrow && screen === "shell"}
                open={panels.isSidebarVisible}
                label={intl.formatMessage({ id: "workspaceSidebar.navigation" })}
                closeLabel={intl.formatMessage({ id: "common.close" })}
                onOpenChange={(open) => {
                  if (!open) panels.handleCloseSidebar();
                }}
                triggerRef={sidebarTrigger}
              >
                <nav
                  className="flex h-full min-h-0 flex-col gap-2 overflow-y-auto p-3"
                  aria-label="Fixture navigation data"
                >
                  <p className="text-ui-sm">
                    真实抽屉/owner；导航数据为 fixture，不是生产任务列表。
                  </p>
                  <Button
                    onClick={() => {
                      action();
                      if (narrow) panels.handleCloseSidebar();
                    }}
                  >
                    Select fixture task / 选择任务
                  </Button>
                  <Button onClick={openPreview}>Open preview / 打开预览</Button>
                  <Button onClick={panels.handleOpenTerminalTab}>Side terminal / 侧栏终端</Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline">Nested menu / 嵌套菜单</Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent>
                      <DropdownMenuItem onSelect={action}>Menu action / 菜单动作</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <Button onClick={showSettings}>Settings page / 设置页</Button>
                  {Array.from({ length: 25 }, (_, index) => (
                    <Button key={index} variant="ghost" onClick={action}>
                      Fixture navigation {index + 1}
                    </Button>
                  ))}
                  <Button onClick={action} data-testid="fixture-navigation-last">
                    Last navigation action
                  </Button>
                </nav>
              </WorkspacePanelDrawer>
            </WorkspaceSidebarPanel>
            <WorkspaceContentColumn id="fixture-content" isNarrowWebLayout={narrow}>
              <WorkspaceBodyPanelGroup isNarrowWebLayout={narrow}>
                <ResizablePanel
                  id="conversation-column"
                  minSize="35%"
                  defaultSize="100%"
                  inert={drawerOpen ? true : undefined}
                >
                  <ResizablePanelGroup
                    orientation="vertical"
                    layoutId="mobile-fixture-conversation"
                    panelIds={COLUMN_IDS}
                    className="h-full min-h-0"
                  >
                    <ResizablePanel id="conversation" minSize="35%">
                      <div className="flex h-full min-h-0 min-w-0 flex-col bg-background">
                        <WorkspaceHeader
                          variant="draft"
                          workspaceAbsPath={workspacePath}
                          projectName="Fixture"
                          activeTaskTitle="Fixture"
                          activeTaskId={null}
                          activeTraceId={null}
                          activeSessionId={null}
                          activeTaskProvider={null}
                          hasUpdateReady={false}
                          sessionLogPath={null}
                          nativeSessionLogProvider={null}
                          nativeSessionLogPath={null}
                          nativeSessionLogExists={false}
                          nativeSessionLogLoading={false}
                          workspaceHeaderState={{ selectedProvider: "glm" }}
                          gitSummary={gitSummary}
                          gitDirtyFileCount={0}
                          isDesktop={false}
                          isNarrowWebLayout={narrow}
                          isSidebarVisible={panels.isSidebarVisible}
                          isTerminalOpen={panels.isTerminalOpen}
                          isSidePaneOpen={!panels.isSidePaneCollapsed}
                          sidePaneTriggerRef={sideTrigger}
                          sidePaneControlsId="fixture-details"
                          onRefreshGit={noop}
                          onToggleTerminal={panels.handleToggleTerminal}
                          onToggleBrowser={panels.handleToggleBrowser}
                          onToggleSidePane={panels.handleToggleSidePaneCollapse}
                          onReloadSession={noop}
                          onCreateTask={action}
                          onOpenWorkspace={noop}
                        />
                        <Controls onSettings={showSettings} onRows={() => setScreen("rows")} />
                        <FixtureConversation
                          openPreview={openPreview}
                          openTerminal={panels.handleOpenTerminalTab}
                        />
                      </div>
                    </ResizablePanel>
                    <AnimatedTerminalPanel
                      services={services}
                      workspaceAbsPath={workspacePath}
                      openWorkspaceKeys={WORKSPACE_KEYS}
                      isVisible={terminal.isVisible}
                      panelRef={terminal.panelRef}
                      panelElementRef={terminal.panelElementRef}
                      onClose={() => panels.setIsTerminalOpen(false)}
                      onOpenBrowserUrl={noop}
                    />
                  </ResizablePanelGroup>
                </ResizablePanel>
                <AnimatedSidePanePanel
                  services={services}
                  isDesktop={false}
                  isVisible={narrow ? !panels.isSidePaneCollapsed : side.isVisible}
                  isNarrowWebLayout={narrow}
                  isWorkspaceVisible={screen === "shell"}
                  drawerId="fixture-details"
                  drawerTriggerRef={sideTrigger}
                  drawerFallbackFocusRef={sidebarTrigger}
                  onCloseSidePane={panels.handleCloseSidePane}
                  sidePaneState={panels.sidePaneState}
                  recentClosedSidePaneTabs={panels.recentClosedSidePaneTabs}
                  isBrowserOpen={false}
                  supportsEmbeddedBrowser={false}
                  ownerWorkspaceKey={workspacePath}
                  workspaceAbsPath={workspacePath}
                  activeTaskId="mobile-fixture-session"
                  sidePaneOwnerId="mobile-fixture-session"
                  gitState={gitState}
                  activeGitSourceId="unstaged"
                  panelRef={side.panelRef}
                  panelElementRef={side.panelElementRef}
                  onPanelResize={side.onPanelResize}
                  browserNavigationRequest={null}
                  browserRestoreUrls={{}}
                  fileChangeFindActiveIndex={0}
                  fileChangeFindNavigationRequestId={0}
                  fileChangeFindQuery=""
                  onFileChangeFindMatchCountChange={noop}
                  onCloseCodeViewer={panels.handleCloseCodeViewer}
                  onCloseGit={panels.handleCloseGit}
                  onActivateTab={panels.handleActivateSidePaneTab}
                  onReorderTab={panels.handleReorderSidePaneTab}
                  onCloseTab={panels.handleCloseSidePaneTab}
                  onCloseOtherTabs={panels.handleCloseOtherSidePaneTabs}
                  onCloseAllTabs={panels.handleCloseAllSidePaneTabs}
                  onReopenClosedTab={panels.handleReopenClosedSidePaneTab}
                  onOpenBrowserTab={noop}
                  onOpenWhiteboard={noop}
                  onOpenDeveloperTools={noop}
                  onOpenTerminalTab={panels.handleOpenTerminalTab}
                  onOpenReviewTab={noop}
                  onOpenSelectionSideConversation={noop}
                  onOpenBrowserUrl={noop}
                  onOpenCodeViewer={panels.handleOpenCodeViewer}
                  onOpenSubagentSession={noop}
                  onRefreshGit={noop}
                  onBrowserNavigationRequestHandled={noop}
                  onBrowserUrlChange={noop}
                  onBrowserPageMetadataChange={noop}
                  onSelectGitSource={noop}
                />
              </WorkspaceBodyPanelGroup>
            </WorkspaceContentColumn>
            <WorkspaceDrawerBackdrop
              open={drawerOpen}
              onClose={
                panels.isSidebarVisible ? panels.handleCloseSidebar : panels.handleCloseSidePane
              }
            />
            <WorkspaceTopNavigation isNativeDesktop={false} blocked={drawerOpen}>
              <DesktopTopOverlay
                workspaceAbsPath={workspacePath}
                isDesktop={false}
                isSidebarVisible={panels.isSidebarVisible}
                updateReadyVersion={null}
                updateState={null}
                toggleSidebarShortcutLabel=""
                newTaskShortcutLabel=""
                goBackShortcutLabel=""
                goForwardShortcutLabel=""
                canTaskNavBack={false}
                canTaskNavForward={false}
                canGoBack={false}
                canGoForward={false}
                platform={platform}
                sidebarTriggerRef={sidebarTrigger}
                sidebarControlsId="fixture-navigation"
                onToggleSidebar={panels.handleToggleSidebar}
                onCreateTask={action}
                onGoBack={noop}
                onGoForward={noop}
              />
            </WorkspaceTopNavigation>
          </WorkspaceShellSurface>
        </DesktopWindowFrame>
      </div>
      {screen === "settings" ? (
        <SettingsPage isDesktop={false} onBack={() => setScreen("shell")} />
      ) : null}
      {screen === "rows" ? <RowsFixture onBack={() => setScreen("shell")} /> : null}
    </>
  );
}
const root = createRoot(document.getElementById("root")!);
root.render(
  <PlatformProvider platform={platform}>
    <ServiceProvider services={services}>
      <StoreProvider broadcastService={services.broadcastService}>
        <TabStoreProvider>
          <LCodeIntlProvider initialLocale={query.get("lang") === "en" ? "en-US" : "zh-CN"}>
            <TooltipProvider>
              <DiffsWorkerPoolProvider>
                <V4ConversationContext.Provider value={conversationContext}>
                  <Fixture />
                </V4ConversationContext.Provider>
              </DiffsWorkerPoolProvider>
            </TooltipProvider>
          </LCodeIntlProvider>
        </TabStoreProvider>
      </StoreProvider>
    </ServiceProvider>
  </PlatformProvider>,
);
if (import.meta.hot)
  import.meta.hot.dispose(() => {
    root.unmount();
    providerConnection.dispose();
    layer.dispose();
  });
