import { useState } from "react";
import type { IServiceAccessor } from "@lcode/services";
import { WorkspaceSidebarItem } from "@/WorkspaceSidebarItem.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { TabStoreProvider } from "@/store/TabStoreProvider.js";
import { StoreProvider, useLCodeStore } from "@/store/StoreProvider.js";
import { LCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ScopedErrorBoundary } from "@/ErrorBoundary.js";
import { THEME_OPTIONS } from "@/themeConfig.js";
import { buildWorkspaceSessionKey } from "@/lib/remoteWorkspaceHistory.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { platform } from "./git-backup-platform.js";

const noop = () => {};
const subscribe = () => ({ dispose: noop });
const unexpectedClaim = async () => {
  throw new Error("Sidebar render fixture must not acquire runtime claims");
};
const tasks: [] = [];
const services = { lcodeTaskService: { onTaskUpdated: subscribe } } as unknown as IServiceAccessor;
const broadcastService = {
  onMessage: subscribe,
  send: async () => {},
  acquireClaim: unexpectedClaim,
  commitClaim: unexpectedClaim,
  releaseClaim: unexpectedClaim,
  tryClaim: unexpectedClaim,
};
const local: WorkspaceTabState = {
  id: "fixture-local" as never,
  kind: "workspace",
  label: "本地项目",
  workspacePath: "/fixture/local",
};
const remote: WorkspaceTabState = {
  id: "fixture-remote" as never,
  kind: "workspace",
  label: "远端项目",
  workspacePath: "/fixture/remote",
  remoteTarget: { kind: "ssh", host: "example.invalid", username: "fixture", port: 22 },
};

function Rows() {
  const [mode, setMode] = useState("idle");
  const [expanded, setExpanded] = useState(false);
  const [revision, setRevision] = useState(0);
  const setTheme = useLCodeStore((state) => state.setTheme);
  const setUiFontSize = useLCodeStore((state) => state.setUiFontSizePx);
  const tab =
    mode === "local"
      ? local
      : {
          ...remote,
          label: `远端项目 ${revision}`,
          ...(mode === "connected" ? { remoteSessionId: "fixture-connected" } : {}),
        };
  const key = buildWorkspaceSessionKey(tab);
  return (
    <main className="max-w-md p-3 text-ui-base">
      <div className="flex flex-wrap gap-2">
        {["local", "idle", "connecting", "failed", "connected"].map((value) => (
          <button
            key={value}
            data-testid={`mode-${value}`}
            onClick={() => {
              setMode(value);
              setExpanded(false);
            }}
          >
            {value}
          </button>
        ))}
        <button data-testid="refresh-actual-row" onClick={() => setRevision((value) => value + 1)}>
          刷新行
        </button>
        <button data-testid="large-type" onClick={() => setUiFontSize(20)}>
          大字号
        </button>
        {THEME_OPTIONS.filter((option) => option.base !== "dynamic").map((option) => (
          <button
            key={option.id}
            data-testid={`theme-${option.id}`}
            onClick={() => setTheme(option.id)}
          >
            {option.id}
          </button>
        ))}
      </div>
      <ScopedErrorBoundary scope="workspace-sidebar-fixture">
        <ul data-testid="actual-sidebar-row">
          <WorkspaceSidebarItem
            tab={tab}
            isActiveWorkspace
            isExpanded={expanded}
            activateTab={noop}
            closeTab={noop}
            toggleWorkspaceExpanded={() => setExpanded((value) => !value)}
            onSelectTask={noop}
            onStartDraftInWorkspace={() => setExpanded(true)}
            taskItems={tasks}
            taskListLoading={false}
            taskListHasMore={false}
            onShowMoreTasks={noop}
            reconnectingRemoteWorkspaceKeys={mode === "connecting" ? [key] : []}
            remoteWorkspaceErrorByWorkspaceKey={
              mode === "failed" ? { [key]: "Fixture connection failed" } : {}
            }
            reconnectingRemoteWorkspaceLogsByWorkspaceKey={{}}
            onReconnectRemoteWorkspace={async () => {
              setMode("connecting");
            }}
          />
        </ul>
      </ScopedErrorBoundary>
    </main>
  );
}

export function SidebarAnimationRows() {
  return (
    <PlatformProvider platform={platform}>
      <ServiceProvider services={services}>
        <StoreProvider broadcastService={broadcastService}>
          <TabStoreProvider>
            <LCodeIntlProvider initialLocale="zh-CN">
              <TooltipProvider>
                <Rows />
              </TooltipProvider>
            </LCodeIntlProvider>
          </TabStoreProvider>
        </StoreProvider>
      </ServiceProvider>
    </PlatformProvider>
  );
}
