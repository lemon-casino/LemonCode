import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { IBroadcastService, IServiceAccessor } from "@lcode/services";
import { ServiceProvider } from "@/hooks/useServices.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { StoreProvider } from "@/store/StoreProvider.js";
import { TabStoreProvider } from "@/store/TabStoreProvider.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { LCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { useWorkspaceGitState } from "@/hooks/useWorkspaceGitState.js";
import { useAppPanels } from "@/hooks/useAppPanels.js";
import { useNarrowWebLayout } from "@/hooks/useNarrowWebLayout.js";
import { WorkspaceHeaderActionSection } from "@/WorkspaceHeaderSections/WorkspaceHeaderActionSection.js";
import { AnimatedSidePanePanel } from "@/app-shell/AnimatedSidePanePanel.js";
import {
  WorkspaceBodyPanelGroup,
  WorkspaceShellSurface,
} from "@/app-shell/WorkspaceShellSurface.js";
import { ResizablePanel } from "@/components/ui/resizable.js";
import { useAnimatedResizablePanel } from "@/app-shell/useAnimatedResizablePanel.js";
import { acquireWorkspaceConnection } from "@/v4/workspaceConnectionRegistry.js";
import { useWorktreeLifecycleStore } from "@/store/worktreeLifecycleStore.js";
import { services as base, metrics, origin } from "./git-session-refresh-runtime.js";
import { platform } from "./git-backup-platform.js";
import "@lcode/ui/styles.css";

const query = new URLSearchParams(location.search);
const noop = () => {};
let warm = false;
let failRead = query.has("fail-read");
let failSubscribe = query.has("fail-subscribe");
let release: (() => void) | undefined;
let earlyReads = 0;
let subscribeAttempts = 0;
const services: IServiceAccessor = {
  ...base,
  lcodeSessionService: {
    ...base.lcodeSessionService,
    readSession: async (params) => {
      if (!warm) {
        earlyReads++;
        throw new Error("Session is not active: fixture-session");
      }
      if (failRead) throw new Error("fixture execution read failed");
      return base.lcodeSessionService.readSession(params);
    },
  },
  lcodeAgentService: {
    ...base.lcodeAgentService,
    subscribeConversationV4: async (params) => {
      subscribeAttempts++;
      if (failSubscribe) throw new Error("fixture subscription failed");
      if (!warm)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return base.lcodeAgentService.subscribeConversationV4(params);
    },
  },
};
useRemoteWorkspaceSessionStore.getState().registerBaseServices(services);
const broadcast = { send: async () => {}, onMessage: () => noop } as IBroadcastService;

function Fixture() {
  const [task, setTask] = useState("parent");
  const [refresh, setRefresh] = useState(0);
  const narrow = useNarrowWebLayout(false);
  const panels = useAppPanels({
    workspaceAbsPath: origin,
    activeTaskId: task,
    sidePaneOwnerId: task,
    isDesktop: false,
    isNarrowWebLayout: narrow,
    defaultWhiteboardNamePrefix: "Fixture",
    platform,
  });
  const { execution, gitState } = useWorkspaceGitState({
    workspacePath: origin,
    sessionId: task,
    gitRefreshToken: refresh,
    includeExtendedData: false,
    livePanelVisible: false,
    autoRefreshEnabled: false,
    onAutoRefresh: noop,
  });
  const open = !panels.isSidePaneCollapsed;
  const side = useAnimatedResizablePanel({
    open,
    expandedSize: "45%",
    rememberExpandedSize: true,
    resizeOnInitialVisibleMount: false,
    resizeEnabled: !narrow,
  });
  // 模拟聊天持有的同一连接/会话租约；它与执行目录观察必须共享一次冷恢复。
  useEffect(() => {
    const connection = acquireWorkspaceConnection(
      { workspacePath: origin },
      services.lcodeAgentService,
    );
    const session = connection.layer.acquire(task);
    return () => {
      session.release();
      connection.release();
    };
  }, [task]);
  Object.assign(window, {
    __sideRecovery: {
      ready: () => {
        warm = true;
        release?.();
        release = undefined;
      },
      repair: () => {
        warm = true;
        failRead = false;
        failSubscribe = false;
      },
      failRead: () => {
        failRead = true;
        useWorktreeLifecycleStore.getState().invalidate(origin);
      },
      switchTask: setTask,
      refresh: () => setRefresh((value) => value + 1),
      metrics: () => ({
        ...metrics,
        subscribeAttempts,
        earlyReads,
        task,
        open,
        pending: execution.pending,
        error: execution.error ?? null,
        path: execution.workspace?.workspacePath,
      }),
    },
  });
  return (
    <WorkspaceShellSurface
      isNarrowWebLayout={narrow}
      isNativeDesktop={false}
      style={{ height: "100dvh" }}
    >
      <WorkspaceBodyPanelGroup isNarrowWebLayout={narrow}>
        <ResizablePanel id="conversation-column" minSize="35%">
          <header className="flex justify-end border-b p-2" data-testid="recovery-header">
            <WorkspaceHeaderActionSection
              variant="draft"
              workspaceAbsPath={origin}
              isDesktop={false}
              isTerminalOpen={false}
              isSidePaneOpen={open}
              isSidePaneReady={Boolean(execution.workspace)}
              isNarrowWebLayout={narrow}
              onToggleTerminal={noop}
              onToggleSidePane={panels.handleToggleSidePaneCollapse}
              simplifyForNarrowRemote
            />
          </header>
          <button
            className="m-4"
            onClick={() =>
              panels.handleOpenCodeViewer({
                type: "text",
                title: "fixture.txt",
                content: "Preview content",
                language: "text",
              })
            }
          >
            打开
          </button>
          <button className="m-4" onClick={panels.handleOpenGit}>
            审查
          </button>
        </ResizablePanel>
        <AnimatedSidePanePanel
          services={services}
          isDesktop={false}
          isVisible={narrow ? open : side.isVisible}
          isNarrowWebLayout={narrow}
          sidePaneState={panels.sidePaneState}
          executionState={
            execution.workspace
              ? undefined
              : { pending: execution.pending, error: execution.error, retry: execution.retry }
          }
          recentClosedSidePaneTabs={panels.recentClosedSidePaneTabs}
          isBrowserOpen={false}
          supportsEmbeddedBrowser={false}
          ownerWorkspaceKey={origin}
          workspaceAbsPath={execution.workspace?.workspacePath ?? origin}
          activeTaskId={task}
          sidePaneOwnerId={task}
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
          onOpenTerminalTab={noop}
          onOpenReviewTab={panels.handleOpenGit}
          onOpenSelectionSideConversation={noop}
          onOpenBrowserUrl={noop}
          onOpenCodeViewer={panels.handleOpenCodeViewer}
          onOpenSubagentSession={noop}
          onRefreshGit={noop}
          onBrowserNavigationRequestHandled={noop}
          onBrowserUrlChange={noop}
          onBrowserPageMetadataChange={noop}
          onSelectGitSource={noop}
          onCloseSidePane={panels.handleCloseSidePane}
        />
      </WorkspaceBodyPanelGroup>
    </WorkspaceShellSurface>
  );
}
createRoot(document.getElementById("root")!).render(
  <PlatformProvider platform={platform}>
    <ServiceProvider services={services}>
      <StoreProvider broadcastService={broadcast}>
        <TabStoreProvider>
          <LCodeIntlProvider initialLocale={query.has("english") ? "en-US" : "zh-CN"}>
            <TooltipProvider>
              <Fixture />
            </TooltipProvider>
          </LCodeIntlProvider>
        </TabStoreProvider>
      </StoreProvider>
    </ServiceProvider>
  </PlatformProvider>,
);
