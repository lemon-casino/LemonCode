import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { buildRemoteWorkspaceIdentity } from "@lcode/shared";
import { WorkspaceSidebar, type SidebarFileTreeOpenRequest } from "@/WorkspaceSidebar.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { useActiveExecutionWorkspace } from "@/hooks/useActiveExecutionWorkspace.js";
import { TabStoreProvider, useTabStoreApi } from "@/store/TabStoreProvider.js";
import { StoreProvider } from "@/store/StoreProvider.js";
import { useLCodeSessionStore } from "@/store/lcodeSessionStore.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { LCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ScopedErrorBoundary } from "@/ErrorBoundary.js";
import { platform } from "./git-backup-platform.js";
import {
  services,
  origin,
  binding,
  calls,
  facts,
  createFileServices,
} from "./sidebar-file-tree-service.js";
import "@/styles.css";

const params = new URLSearchParams(location.search);
facts.pendingSession = params.has("pending");
const noop = () => {};
const subscribe = () => ({ dispose: noop });
const broadcast = { send: async () => {}, onMessage: subscribe } as never;
const theme = params.has("light") ? "zai-light" : "zai-dark";
document.documentElement.classList.toggle("dark", theme === "zai-dark");
document.documentElement.classList.add(`theme-${theme}`);
useRemoteWorkspaceSessionStore.getState().registerBaseServices(services);
const remoteTargets = ["a", "b"].map((name) => {
  const sessionId = `remote-${name}`;
  const workspaceIdentity = buildRemoteWorkspaceIdentity(origin, {
    kind: "ssh",
    host: `${name}.example.invalid`,
    username: "fixture",
    port: 22,
  });
  useRemoteWorkspaceSessionStore.getState().registerSession({
    sessionId,
    services: createFileServices(sessionId),
  });
  return {
    workspacePath: origin,
    workspaceIdentity,
    workspaceRemoteSessionId: sessionId,
    workspaceName: sessionId,
  };
});

function Fixture() {
  const tabStore = useTabStoreApi();
  const [ready, setReady] = useState(false);
  const [request, setRequest] = useState<SidebarFileTreeOpenRequest | null>(null);
  const execution = useActiveExecutionWorkspace(origin, undefined, "cold-session");
  useEffect(() => {
    tabStore.getState().addTab(origin);
    useLCodeSessionStore.getState().setActiveTaskId(origin, "cold-session");
    setReady(true);
  }, [tabStore]);
  Object.assign(globalThis, {
    __sidebarFiles: {
      calls,
      facts,
      remoteTargets,
      disconnect: (sessionId: string) =>
        useRemoteWorkspaceSessionStore.getState().unregisterSession(sessionId),
      open: (target: SidebarFileTreeOpenRequest["target"]) =>
        setRequest((current) => ({ id: (current?.id ?? 0) + 1, target })),
      failFiles: (value: boolean) => {
        facts.failFiles = value;
      },
      activeTask: () => useLCodeSessionStore.getState().getWorkspaceState(origin).activeTaskId,
    },
  });
  return (
    <main className="h-screen bg-background text-foreground text-ui-base">
      <output data-testid="execution-error">{execution.error ?? "pending"}</output>
      <div className="w-80 max-w-full" style={{ height: "calc(100vh - 24px)" }}>
        {ready ? (
          <ScopedErrorBoundary scope="file-tree-fixture">
            <WorkspaceSidebar
              workspacePath={origin}
              executionWorkspace={execution.workspace ?? null}
              executionBinding={params.has("worktree") ? binding : undefined}
              fileTreeOpenRequest={request}
              theme={theme}
              onSelectTask={noop}
              onStartDraftInWorkspace={noop}
              onCreateTask={() => {
                facts.newTasks++;
              }}
              onCreateConversationTask={noop}
              onOpenFolderFromWorkspaceMenu={noop}
              onConnectRemote={async () => "fixture"}
              onSelectRemoteProject={async () => {}}
              onCancelRemoteProject={async () => {}}
              onReconnectRemoteWorkspace={async () => {}}
              reconnectingRemoteWorkspaceKeys={[]}
              remoteWorkspaceErrorByWorkspaceKey={{}}
              onOpenCommandCenter={noop}
              hideTopSpacer
            />
          </ScopedErrorBoundary>
        ) : null}
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <PlatformProvider platform={platform}>
    <ServiceProvider services={services}>
      <StoreProvider broadcastService={broadcast}>
        <TabStoreProvider>
          <LCodeIntlProvider initialLocale={params.has("english") ? "en-US" : "zh-CN"}>
            <TooltipProvider>
              <Fixture />
            </TooltipProvider>
          </LCodeIntlProvider>
        </TabStoreProvider>
      </StoreProvider>
    </ServiceProvider>
  </PlatformProvider>,
);
