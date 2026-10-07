import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { IBroadcastService } from "@lcode/services";
import type { SessionPhase } from "@lcode/shared/lcode-protocol-v4";
import { useWorkspaceGitState } from "@/hooks/useWorkspaceGitState.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { LCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { StoreProvider } from "@/store/StoreProvider.js";
import { TabStoreProvider } from "@/store/TabStoreProvider.js";
import { useWorktreeLifecycleStore } from "@/store/worktreeLifecycleStore.js";
import { ConversationStatusPanel } from "@/v4/ConversationStatusPanel.js";
import { SubagentDirectorySidePane } from "@/app-shell/SubagentDirectorySidePane.js";
import { SubagentSessionSidePane } from "@/app-shell/SubagentSessionSidePane.js";
import type { SubagentDirectorySidePaneTab } from "@/lib/workspaceSidePane.js";
import { fixture, origin, services, metrics, plan } from "./git-session-refresh-runtime.js";
import { RemoteExecutionFixture } from "./git-session-refresh-remote.js";
import { platform } from "./git-backup-platform.js";
import "@lcode/ui/styles.css";

const params = new URLSearchParams(location.search);
const broadcastService = {
  send: async () => {},
  onMessage: () => () => {},
} as unknown as IBroadcastService;
let directoryMounts = 0;
function Directory({ onOpen }: { onOpen: (child: string) => void }) {
  useEffect(() => {
    directoryMounts++;
  }, []);
  const tab: SubagentDirectorySidePaneTab = {
    id: "directory",
    type: "subagent-directory",
    title: "Agents",
    workspaceKey: origin,
    workspacePath: origin,
    rootSessionId: "parent",
    parentSessionId: "parent",
  };
  return (
    <SubagentDirectorySidePane
      tab={tab}
      onOpenSubagentSession={(request) => {
        fixture.openedChild = request.childSessionId;
        onOpen(request.childSessionId);
      }}
    />
  );
}
function Fixture() {
  const [refreshToken, setRefreshToken] = useState(0);
  const refresh = useCallback(() => setRefreshToken((value) => value + 1), []);
  const [task, setTask] = useState("parent");
  const [phase, setPhase] = useState<SessionPhase>("completedSuccess");
  const [agentOpen, setAgentOpen] = useState(false);
  const [directory, setDirectory] = useState(false);
  const [child, setChild] = useState<string | null>(null);
  const [historyOnly, setHistoryOnly] = useState(false);
  const [panelVariant, setPanelVariant] = useState<"mini" | "panel" | null>("panel");
  const { execution, gitState } = useWorkspaceGitState({
    workspacePath: origin,
    sessionId: task,
    gitRefreshToken: refreshToken,
    includeExtendedData: false,
    livePanelVisible: false,
    autoRefreshEnabled: true,
    onAutoRefresh: refresh,
  });
  Object.assign(fixture, {
    metrics: () => ({
      ...metrics,
      directoryMounts,
      executionPath: execution.workspace?.workspacePath,
      agentOpen,
      branch: gitState.summary.branchName,
    }),
    refresh,
    commit: () => {
      fixture.dirty = false;
      refresh();
    },
    phase: setPhase,
    historyOnly: () => setHistoryOnly(true),
    collapse: () => setPanelVariant("mini"),
    switchTask: setTask,
    invalidate: () => useWorktreeLifecycleStore.getState().invalidate(origin),
  });
  return (
    <div className="p-3 text-foreground">
      <output data-testid="execution">{execution.workspace?.workspacePath ?? "pending"}</output>
      <section className="relative" style={{ minHeight: 640 }} data-testid="status">
        <ConversationStatusPanel
          workspacePath={execution.workspace?.workspacePath ?? origin}
          parentSessionId={task}
          rootSessionId={task}
          gitSummary={historyOnly ? undefined : gitState.summary}
          onRefreshGit={historyOnly ? undefined : refresh}
          plan={historyOnly ? null : plan}
          executionPhase={phase}
          endedSubagentCount={4}
          summaryPanelVariantOverride={panelVariant}
          onVariantChange={setPanelVariant}
          agentSectionOpen={agentOpen}
          onAgentSectionOpenChange={setAgentOpen}
          onOpenSubagentDirectory={() => setDirectory(true)}
        />
      </section>
      {execution.workspace && directory ? (
        <section data-testid="directory">
          <Directory onOpen={setChild} />
        </section>
      ) : null}
      {execution.workspace && child ? (
        <section className="h-96" data-testid="child-transcript">
          <SubagentSessionSidePane
            tab={{
              id: `child-${child}`,
              type: "subagent-session",
              title: child,
              workspaceKey: origin,
              workspacePath: origin,
              rootSessionId: "parent",
              parentSessionId: "parent",
              childSessionId: child,
              subagentType: "review",
            }}
            focused
            onOpenSubagentSession={(request) => setChild(request.childSessionId)}
          />
        </section>
      ) : null}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ServiceProvider services={services}>
      <PlatformProvider platform={platform}>
        <StoreProvider broadcastService={broadcastService}>
          <TabStoreProvider>
            <LCodeIntlProvider initialLocale={params.has("english") ? "en-US" : "zh-CN"}>
              <TooltipProvider>
                {params.has("identity") ? <RemoteExecutionFixture /> : <Fixture />}
              </TooltipProvider>
            </LCodeIntlProvider>
          </TabStoreProvider>
        </StoreProvider>
      </PlatformProvider>
    </ServiceProvider>
  </StrictMode>,
);
