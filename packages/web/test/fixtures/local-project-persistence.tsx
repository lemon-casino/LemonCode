import { lazy, Suspense, useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AppSettings } from "@lcode/shared";
import type { IServiceAccessor } from "@lcode/services";
import { ServiceProvider } from "@/hooks/useServices.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useTabPersistence } from "@/hooks/useTabPersistence.js";
import { LCodeIntlProvider, useLCodeIntl } from "@/i18n/IntlProvider.js";
import { StoreProvider } from "@/store/StoreProvider.js";
import { TabStoreProvider, useTabStore, useTabStoreApi } from "@/store/TabStoreProvider.js";
import { buildWorkspaceProjectMenuTabs } from "@/workspaceProjectMenu.js";
import { useRootWorkspaceActions } from "@/root/useRootWorkspaceActions.js";
import { restorePersistedRemoteWorkspaceSessions } from "@/root/remoteWorkspaceSessionPersistence.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import { platform } from "./git-backup-platform.js";
import "@/styles.css";

const Root = lazy(() => import("@/Root.js").then((module) => ({ default: module.Root })));
const origin = new URLSearchParams(location.search).get("settingsOrigin")!;
const pending = () => new Promise<never>(() => {});
const dispose = () => ({ dispose() {} });
const fixture = {
  reads: 0,
  runtimePreferencesSynced: 0,
  modelReads: 0,
  idle: [] as IdleRequestCallback[],
};
Object.assign(window, { __projectFixture: fixture });
// 延迟恢复由测试显式放行，验证真正的 active-first 边界而不是依赖时间等待。
window.requestIdleCallback = (callback) => fixture.idle.push(callback);
window.cancelIdleCallback = () => {
  fixture.idle = [];
};
async function settingsRequest(method: string, patch?: Partial<AppSettings>) {
  const response = await fetch(origin, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(patch ? { body: JSON.stringify(patch) } : {}),
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}
const stub = new Proxy(
  {},
  {
    get: (_target, property) =>
      String(property).startsWith("on") ? dispose : async () => undefined,
  },
);
const services = new Proxy(
  {
    settingService: {
      get: async () => {
        fixture.reads += 1;
        return settingsRequest("GET");
      },
      update: async (patch: Partial<AppSettings>) => {
        await settingsRequest("POST", patch);
      },
    },
    broadcastService: { onMessage: dispose, send: async () => {} },
    modelSelectionService: {
      onDidChange: dispose,
      getView: () => {
        fixture.modelReads += 1;
        return pending();
      },
    },
    providerSettingsService: { onDidChange: dispose, getView: pending, refresh: async () => {} },
    lcodeAgentService: {
      syncAppRuntimePreferences: async () => {
        fixture.runtimePreferencesSynced += 1;
      },
    },
    fileService: { ensureConversationWorkspace: async () => ({ path: "/fixture/conversation" }) },
  },
  { get: (target, property) => Reflect.get(target, property) ?? stub },
) as unknown as IServiceAccessor;

function RestoreActions() {
  const { intl } = useLCodeIntl();
  const { settings, update } = useSettings();
  const tabs = useTabStore((state) => state.tabs);
  const store = useTabStoreApi();
  const [error, setError] = useState("");
  const restore = useCallback(
    (snapshot: AppSettings) =>
      restorePersistedRemoteWorkspaceSessions({
        settings: snapshot,
        tabStoreApi: store,
        restoreMode: "active-first",
        conversationWorkspacePath: "/fixture/conversation",
      }),
    [store],
  );
  const lifecycle = useTabPersistence({
    settingService: services.settingService,
    restorePersistedSession: restore,
  });
  const actions = useRootWorkspaceActions({
    intl,
    platform,
    services,
    tabStoreApi: store,
    addTab: store.getState().addTab,
    activeWorkspacePath: null,
    activeWorkspaceIdentity: null,
    supportsSettings: true,
    allowOpenWorkspace: true,
    preferDirectoryBrowser: false,
    refreshProviderState: async () => {},
    updateAppSettings: update,
    setOAuthError: () => {},
    setUser: () => {},
  });
  const projects = buildWorkspaceProjectMenuTabs({
    localProjects: settings?.localProjects ?? [],
    workspaceTabs: tabs.filter(isWorkspaceTab).map((tab) => ({ ...tab, label: tab.workspacePath })),
  });
  return (
    <main className="p-4 text-ui-base">
      <output data-testid="full-restore">{String(lifecycle.hasCompletedFullRestore)}</output>
      <output data-testid="tab-count">{tabs.filter(isWorkspaceTab).length}</output>
      <ul data-testid="projects">
        {projects.map((project) => (
          <li key={project.localProjectId ?? project.workspacePath}>
            <button
              onClick={() =>
                void actions.handleSelectProject(project.workspacePath, {
                  localProjectId: project.localProjectId,
                })
              }
            >
              {project.label}
            </button>
          </li>
        ))}
      </ul>
      <button
        onClick={() => {
          const callbacks = fixture.idle.splice(0);
          callbacks.forEach((callback) => callback({ didTimeout: false, timeRemaining: () => 50 }));
        }}
      >
        Complete restore
      </button>
      <button
        onClick={() =>
          void actions
            .handleCreateLocalProject({
              name: "Replacement",
              sourceFolderPaths: ["C:/fixture/other"],
            })
            .catch((cause) => setError(String(cause)))
        }
      >
        Duplicate project
      </button>
      <button
        onClick={() =>
          void (async () => {
            await actions.handleRemoveLocalProject({
              projectId: "fixture-project-a",
              workspacePath: "C:/fixture/app",
            });
            for (const tab of store.getState().tabs.filter(isWorkspaceTab)) {
              if (tab.workspacePath === "C:/fixture/app") store.getState().closeTab(tab.id);
            }
          })()
        }
      >
        Remove project
      </button>
      <output data-testid="error">{error}</output>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <LCodeIntlProvider initialLocale="zh-CN">
    {new URLSearchParams(location.search).has("gatedRoot") ? (
      <Suspense fallback={null}>
        <Root
          services={services}
          platform={platform}
          isDesktop
          restoreSession
          allowRemoteWorkspace={false}
        />
      </Suspense>
    ) : (
      <ServiceProvider services={services}>
        <PlatformProvider platform={platform}>
          <StoreProvider broadcastService={services.broadcastService}>
            <TabStoreProvider>
              <RestoreActions />
            </TabStoreProvider>
          </StoreProvider>
        </PlatformProvider>
      </ServiceProvider>
    )}
  </LCodeIntlProvider>,
);
