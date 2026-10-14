import { lazy, Suspense, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { appSettingsSchema, type AppSettings } from "@lcode/shared";
import type { IServiceAccessor } from "@lcode/services";
import { LCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { useTabPersistence } from "@/hooks/useTabPersistence.js";
import {
  RemoteBrowserNavigationScopeContext,
  useRemoteBrowserNavigationPersistence,
} from "@/hooks/useRemoteBrowserNavigationPersistence.js";
import { TabStoreProvider, useTabStore, useTabStoreApi } from "@/store/TabStoreProvider.js";
import { StoreProvider } from "@/store/StoreProvider.js";
import { useLCodeSessionStore } from "@/store/lcodeSessionStore.js";
import { usePaneSessionPersistence } from "@/v4/usePaneSessionPersistence.js";
import { WelcomeScreen } from "@/WelcomeScreen.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { platform } from "./git-backup-platform.js";
import "@/styles.css";

const params = new URLSearchParams(location.search);
const scope = params.get("device") ?? "device-a";
const settings = appSettingsSchema.parse({
  providerFamilyDomainMigrated: true,
  localProjects: [
    { id: "project-a", name: "A", primaryFolderPath: "/a", sourceFolderPaths: ["/a"] },
    ...(!params.has("deletedProject")
      ? [{ id: "project-b", name: "B", primaryFolderPath: "/b", sourceFolderPaths: ["/b"] }]
      : []),
  ],
  lastWorkspaceSession: [
    { kind: "local", workspacePath: "/a", localProjectId: "project-a" },
    ...(!params.has("deletedProject")
      ? [{ kind: "local", workspacePath: "/b", localProjectId: "project-b" }]
      : []),
  ],
  lastActiveTabIndex: 0,
});
const dispose = () => ({ dispose() {} });
const stub = new Proxy(
  {},
  {
    get: (_target, property) =>
      String(property).startsWith("on") ? dispose : async () => undefined,
  },
);
let release: (() => void) | undefined;
const barrier = params.has("hold")
  ? new Promise<void>((resolve) => {
      release = resolve;
    })
  : Promise.resolve();
const fixture = { writes: [] as Partial<AppSettings>[], release: () => release?.(), reads: 0 };
Object.assign(window, { __navigationFixture: fixture });
const services = new Proxy(
  {
    settingService: {
      get: async () => {
        fixture.reads += 1;
        return settings;
      },
      update: async (patch: Partial<AppSettings>) => {
        fixture.writes.push(patch);
      },
    },
    broadcastService: { onMessage: dispose, send: async () => {} },
    fileService: {
      ensureConversationWorkspace: async () => ({ path: "/default" }),
      stat: async () => ({ type: "directory" }),
    },
    lcodeTaskService: {
      getTaskMeta: async () => {
        await barrier;
        if (params.has("networkFailure")) throw new Error("fixture disconnected");
        return params.has("deletedTask") ? null : { taskId: "b2" };
      },
    },
    oauthService: {
      getProviders: async () => [],
      getActiveProvider: async () => null,
      getCachedSession: async () => null,
      restoreCachedSessionState: async () => ({ status: "signed-out" }),
    },
    // 真正 Root 的首次欢迎与退出规则单独验证；这里保持 provider 启动门禁，避免渲染无关业务界面。
    modelSelectionService: { onDidChange: dispose, getView: () => new Promise(() => {}) },
    providerSettingsService: {
      onDidChange: dispose,
      getView: () => new Promise(() => {}),
      refresh: async () => {},
    },
    lcodeAgentService: { syncAppRuntimePreferences: async () => {} },
  },
  { get: (target, property) => Reflect.get(target, property) ?? stub },
) as unknown as IServiceAccessor;

function NavigationFixture() {
  const tabs = useTabStoreApi();
  const path = useTabStore((state) => state.activeWorkspacePath);
  const navigation = useRemoteBrowserNavigationPersistence({ scope, services, tabStoreApi: tabs });
  const [welcome, setWelcome] = useState(!navigation.hasEntered);
  const lifecycle = useTabPersistence({
    settingService: services.settingService,
    restoreSession: !welcome,
    persistSession: false,
    syncRecentProjects: false,
    restorePersistedSession: navigation.restore,
  });
  const workspace = useLCodeSessionStore((state) => state.getWorkspaceState(path ?? "/default"));
  useEffect(() => {
    if (!welcome && lifecycle.hasCompletedFullRestore && path) navigation.beginRemembering();
  }, [welcome, lifecycle.hasCompletedFullRestore, path, navigation.beginRemembering]);
  usePaneSessionPersistence({
    workspaceKey: path ?? "/default",
    activeSessionId: workspace.activeTaskId,
    draftFocusVersion: workspace.draftFocusVersion,
    selectSession: (id) => useLCodeSessionStore.getState().setActiveTaskId(path!, id),
  });
  if (welcome)
    return (
      <WelcomeScreen
        onComplete={() => {
          navigation.enter();
          setWelcome(false);
        }}
      />
    );
  if (lifecycle.isRestoring) return <div data-testid="loading">加载中</div>;
  return (
    <main className="p-4 text-ui-base">
      <output data-testid="path">{path}</output>
      <output data-testid="task">{workspace.activeTaskId ?? "draft"}</output>
      <button
        onClick={() => {
          tabs.getState().addTab("/b", { localProjectId: "project-b" });
          useLCodeSessionStore.getState().setActiveTaskId("/b", "b2");
        }}
      >
        选择 B2
      </button>
      <button onClick={() => useLCodeSessionStore.getState().startDraft(path!)}>新建任务</button>
    </main>
  );
}
const Root = lazy(() => import("@/Root.js").then((module) => ({ default: module.Root })));
createRoot(document.getElementById("root")!).render(
  <LCodeIntlProvider initialLocale="zh-CN">
    {params.has("root") ? (
      <Suspense fallback={null}>
        <Root
          services={services}
          platform={platform}
          remoteBrowserNavigationScope={scope}
          allowRemoteWorkspace={false}
        />
      </Suspense>
    ) : (
      <TooltipProvider>
        <ServiceProvider services={services}>
          <PlatformProvider platform={platform}>
            <StoreProvider broadcastService={services.broadcastService}>
              <TabStoreProvider>
                <RemoteBrowserNavigationScopeContext.Provider value={scope}>
                  <NavigationFixture />
                </RemoteBrowserNavigationScopeContext.Provider>
              </TabStoreProvider>
            </StoreProvider>
          </PlatformProvider>
        </ServiceProvider>
      </TooltipProvider>
    )}
  </LCodeIntlProvider>,
);
