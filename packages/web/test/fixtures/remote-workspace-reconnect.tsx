import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { IServiceAccessor } from "@lcode/services";
import {
  appSettingsSchema,
  buildRemoteWorkspaceIdentity,
  WINDOW_WORKSPACE_RECONNECT_UNAVAILABLE,
  type WindowWorkspaceCatalogEntry,
  type WindowWorkspaceReconnectRequest,
  type WindowWorkspaceReconnectResult,
  type WindowWorkspaceReconnectTarget,
} from "@lcode/shared";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { LCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { WorkspaceSidebarItem } from "@/WorkspaceSidebarItem.js";
import { TabStoreProvider, useTabStore, useTabStoreApi } from "@/store/TabStoreProvider.js";
import { createTabStore, isWorkspaceTab } from "@/store/tabStore.js";
import { createRemoteBrowserWorkspaceCatalog } from "@/hooks/remoteBrowserWorkspaceCatalog.js";
import { useWindowWorkspaceReconnect } from "@/hooks/useWindowWorkspaceReconnect.js";
import type { DesktopWorkspaceReconnect } from "@/hooks/windowWorkspaceReconnect.js";
import { applyTheme } from "@/useTheme.js";
import { platform } from "./git-backup-platform.js";
import "@/styles.css";

const noop = () => {};
const english = new URLSearchParams(location.search).has("english");
applyTheme(english ? "zai-dark" : "zai-light");
const targets = [
  { kind: "ssh" as const, host: "fixture.invalid", username: "fixture" },
  { kind: "wsl" as const, distro: "Fixture" },
  { kind: "docker" as const, container: "fixture" },
];
let catalog: WindowWorkspaceCatalogEntry[] = targets.map((target) => ({
  scope: {
    kind: "remote",
    remoteSessionId: `${target.kind}-old`,
    generation: 1,
    workspacePath: "/same",
    workspaceIdentity: buildRemoteWorkspaceIdentity("/same", target),
  },
  target,
  sourceAvailability: "offline",
}));
const desktopTabs = createTabStore(null);
desktopTabs.getState().addTab("/desktop-current");
for (const entry of catalog)
  desktopTabs.getState().ensureWorkspaceTab("/same", {
    workspaceIdentity: entry.scope.workspaceIdentity,
    remoteTarget: entry.target,
  });
let listener: ((request: WindowWorkspaceReconnectRequest) => void) | undefined;
let sequence = 0;
const requests = new Map<string, { resolve(): void; reject(error: Error): void }>();
const catalogListeners = new Set<(entries: WindowWorkspaceCatalogEntry[]) => void>();
const fixture = {
  browserDirectCalls: 0,
  settingWrites: 0,
  desktopCalls: [] as Array<{ key: string; options: unknown }>,
  requestTargets: [] as WindowWorkspaceReconnectTarget[],
  fail: false,
  release: () => {},
  stopDesktop: () => {},
  nativeReconnect: (_kind: string) => {},
  nativeSettled: 0,
  disconnect: (kind: string) => {
    catalog = catalog.map((entry) =>
      entry.target.kind === kind ? { ...entry, sourceAvailability: "offline" } : entry,
    );
    for (const change of catalogListeners) change(catalog);
    desktopTabs.setState((state) => ({
      tabs: state.tabs.map((tab) =>
        isWorkspaceTab(tab) && tab.remoteTarget?.kind === kind
          ? { ...tab, remoteSessionId: undefined }
          : tab,
      ),
    }));
  },
  removeDesktop: (kind: string) =>
    desktopTabs.setState((state) => ({
      tabs: state.tabs.filter((tab) => !isWorkspaceTab(tab) || tab.remoteTarget?.kind !== kind),
    })),
  desktopActive: () => desktopTabs.getState().activeWorkspacePath,
};
const windowWorkspaceService = {
  getCatalog: async () => catalog,
  onDidChangeCatalog: (change: (entries: WindowWorkspaceCatalogEntry[]) => void) => {
    catalogListeners.add(change);
    return { dispose: () => catalogListeners.delete(change) };
  },
  requestReconnect: async (target: WindowWorkspaceReconnectTarget) => {
    fixture.requestTargets.push(target);
    if (!listener) throw new Error(WINDOW_WORKSPACE_RECONNECT_UNAVAILABLE);
    const requestId = `request-${++sequence}`;
    await new Promise<void>((resolve, reject) => {
      requests.set(requestId, { resolve, reject });
      listener!({ ...target, requestId });
    });
  },
  onDynamicReconnectRequested:
    () => (handle: (request: WindowWorkspaceReconnectRequest) => void) => {
      listener = handle;
      return {
        dispose() {
          listener = undefined;
          for (const pending of requests.values())
            pending.reject(new Error(WINDOW_WORKSPACE_RECONNECT_UNAVAILABLE));
          requests.clear();
        },
      };
    },
  completeReconnect: async (result: WindowWorkspaceReconnectResult) => {
    const pending = requests.get(result.requestId);
    if (!pending) return false;
    requests.delete(result.requestId);
    if (result.ok) pending.resolve();
    else pending.reject(new Error(result.error));
    return true;
  },
};
const base = {
  windowWorkspaceService,
  settingService: {
    get: async () => appSettingsSchema.parse({}),
    update: async () => {
      fixture.settingWrites++;
    },
  },
  broadcastService: { onMessage: () => ({ dispose() {} }), send: async () => {} },
  lcodeTaskService: {},
  lcodeAgentService: {},
} as unknown as IServiceAccessor;
base.createWorkspaceServiceAccessor = () => base;
const desktopReconnect: DesktopWorkspaceReconnect = async (key, options) => {
  fixture.desktopCalls.push({ key, options });
  try {
    await new Promise<void>((resolve, reject) => {
      fixture.release = () =>
        fixture.fail ? reject(new Error("fixture reconnect failed")) : resolve();
    });
  } catch (error) {
    // 原桌面 helper 在默认模式下展示错误后吞掉失败，转发 RPC 必须显式请求真实结果。
    if (options?.throwOnFailure) throw error;
    return;
  }
  catalog = catalog.map((entry) =>
    entry.scope.workspaceIdentity === key
      ? {
          ...entry,
          sourceAvailability: "online",
          scope: {
            ...entry.scope,
            generation: entry.scope.generation + 1,
            remoteSessionId: `${entry.target.kind}-ready-${entry.scope.generation + 1}`,
          },
        }
      : entry,
  );
  for (const change of catalogListeners) change(catalog);
  const entry = catalog.find((entry) => entry.scope.workspaceIdentity === key)!;
  desktopTabs.getState().ensureWorkspaceTab(entry.scope.workspacePath, {
    workspaceIdentity: key,
    remoteTarget: entry.target,
    remoteSessionId: entry.scope.remoteSessionId,
  });
};
function DesktopOwner() {
  const bridge = useWindowWorkspaceReconnect({
    services: base,
    tabs: desktopTabs,
    isDesktop: true,
    desktopReconnect,
  });
  fixture.nativeReconnect = (kind) => {
    const identity = catalog.find((entry) => entry.target.kind === kind)!.scope.workspaceIdentity;
    void bridge.reconnect(identity).then(() => {
      fixture.nativeSettled++;
    });
  };
  return null;
}
function Browser() {
  const browserTabs = useTabStoreApi();
  const tabs = useTabStore((state) => state.tabs);
  const { reconnect, pendingKeys, errors } = useWindowWorkspaceReconnect({
    services: base,
    tabs: browserTabs,
    isDesktop: false,
    browserScope: "paired-fixture",
    desktopReconnect: async () => {
      fixture.browserDirectCalls++;
      throw new Error("Remote workspace is disabled in this mode");
    },
  });
  useEffect(() => {
    browserTabs.getState().ensureWorkspaceTab("/same");
    for (const entry of catalog)
      browserTabs.getState().ensureWorkspaceTab("/same", {
        workspaceIdentity: entry.scope.workspaceIdentity,
        remoteTarget: entry.target,
      });
    browserTabs.setState((state) => ({
      tabs: state.tabs.map((tab) =>
        isWorkspaceTab(tab) && tab.remoteTarget
          ? { ...tab, label: tab.remoteTarget.kind.toUpperCase() }
          : tab,
      ),
    }));
    const projection = createRemoteBrowserWorkspaceCatalog(base, browserTabs);
    void projection.prepare().then(() => projection.reconcile());
    return () => projection.dispose();
  }, [browserTabs]);
  return (
    <main className="mx-auto max-w-xl p-4 text-ui-base">
      <p>Paired remote control</p>
      <ul>
        {tabs.filter(isWorkspaceTab).map((tab) => (
          <div key={tab.id} data-testid={`row-${tab.remoteTarget?.kind ?? "local"}`}>
            <WorkspaceSidebarItem
              tab={tab}
              isActiveWorkspace={false}
              isExpanded={false}
              activateTab={noop}
              closeTab={noop}
              toggleWorkspaceExpanded={noop}
              onSelectTask={noop}
              onStartDraftInWorkspace={noop}
              taskItems={[]}
              taskListLoading={false}
              taskListHasMore={false}
              onShowMoreTasks={noop}
              reconnectingRemoteWorkspaceKeys={pendingKeys}
              remoteWorkspaceErrorByWorkspaceKey={errors}
              reconnectingRemoteWorkspaceLogsByWorkspaceKey={{}}
              onReconnectRemoteWorkspace={reconnect}
            />
            <output data-testid={`session-${tab.remoteTarget?.kind ?? "local"}`}>
              {tab.remoteSessionId ?? "offline"}
            </output>
          </div>
        ))}
      </ul>
      <output data-testid="pending">{JSON.stringify(pendingKeys)}</output>
    </main>
  );
}
function Page() {
  const [desktop, setDesktop] = useState(true);
  fixture.stopDesktop = () => setDesktop(false);
  return (
    <PlatformProvider platform={platform}>
      <ServiceProvider services={base}>
        <LCodeIntlProvider initialLocale={english ? "en-US" : "zh-CN"}>
          <TooltipProvider>
            {desktop ? <DesktopOwner /> : null}
            <TabStoreProvider>
              <Browser />
            </TabStoreProvider>
          </TooltipProvider>
        </LCodeIntlProvider>
      </ServiceProvider>
    </PlatformProvider>
  );
}
Object.assign(window, { __reconnectFixture: fixture });
createRoot(document.getElementById("root")!).render(<Page />);
