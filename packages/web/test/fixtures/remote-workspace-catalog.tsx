import { useEffect, useMemo } from "react";
import { createRoot } from "react-dom/client";
import {
  appSettingsSchema,
  buildRemoteWorkspaceIdentity,
  type WindowWorkspaceCatalogEntry,
  type WindowWorkspaceScope,
  type LCodeTaskMeta,
} from "@lcode/shared";
import type { IServiceAccessor, LCodeTaskListQuery, WorktreeBinding } from "@lcode/services";
import { LCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { TabStoreProvider, useTabStore, useTabStoreApi } from "@/store/TabStoreProvider.js";
import { useLCodeSessionStore } from "@/store/lcodeSessionStore.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import { useTabPersistence } from "@/hooks/useTabPersistence.js";
import { useRemoteBrowserNavigationPersistence } from "@/hooks/useRemoteBrowserNavigationPersistence.js";
import { useSidebarWorktrees } from "@/hooks/useSidebarWorktrees.js";
import { useGroupedTaskView } from "@/hooks/useGroupedTaskView.js";
import "@/styles.css";

const targets = [
  { kind: "ssh" as const, host: "example.invalid", username: "fixture" },
  { kind: "wsl" as const, distro: "FixtureDistro" },
  { kind: "docker" as const, container: "fixture-container" },
];
let catalog: WindowWorkspaceCatalogEntry[] = targets.map((target, index) => ({
  scope: {
    kind: "remote",
    remoteSessionId: `session-${index}`,
    generation: 1,
    workspacePath: "/same",
    workspaceIdentity: buildRemoteWorkspaceIdentity("/same", target),
  },
  target,
  sourceAvailability: "online",
}));
const catalogListeners = new Set<(catalog: WindowWorkspaceCatalogEntry[]) => void>();
const noEvent = () => ({ dispose() {} });
const changes = {
  event: (listener: (catalog: WindowWorkspaceCatalogEntry[]) => void) => {
    catalogListeners.add(listener);
    return {
      dispose() {
        catalogListeners.delete(listener);
      },
    };
  },
  fire: (catalog: WindowWorkspaceCatalogEntry[]) => {
    for (const listener of catalogListeners) listener(catalog);
  },
};
const reads: string[] = [];
const writes: string[] = [];
const settings = appSettingsSchema.parse({
  lastWorkspaceSession: [
    { kind: "local", workspacePath: "/same" },
    ...catalog.map((entry) => ({
      kind: "remote",
      workspacePath: entry.scope.workspacePath,
      workspaceIdentity: entry.scope.workspaceIdentity,
      target: entry.target,
      lastOpenedAt: 1,
      lastConnectionStatus: "connected",
    })),
  ],
});
const taskFor = (key: string, identity?: string): LCodeTaskMeta =>
  ({
    taskId: `${key}-task`,
    workspacePath: "/same",
    workspaceIdentity: identity,
    title: `${key} task`,
    status: "completed",
    createdAt: 1,
    updatedAt: 1,
  }) as LCodeTaskMeta;
const makeServices = (key: string, identity?: string, generation = 1) =>
  ({
    fileService: {
      stat: async () => {
        reads.push(`stat:${key}`);
        return { type: "directory" };
      },
      ensureConversationWorkspace: async () => ({ path: "/default" }),
    },
    lcodeTaskService: {
      getTaskMeta: async () => {
        reads.push(`task:${key}`);
        return taskFor(key, identity);
      },
      listGroupedTaskViewStructure: async () => {
        reads.push(`group:${key}`);
        return {
          groups: [
            {
              id: "same-group",
              title: `${key} group${generation > 1 ? " reconnected" : ""}`,
              color: "gray",
              createdAt: 1,
              updatedAt: 1,
            },
          ],
          members: [
            {
              groupId: "same-group",
              workspaceKey: identity ?? "/same",
              workspacePath: "/same",
              workspaceIdentity: identity,
              taskId: `${key}-task`,
              sortOrder: 1,
              addedAt: 1,
            },
          ],
          topLevelOrders: [{ type: "group", groupId: "same-group", sortOrder: 1 }],
        };
      },
      listTasks: async (scope: { workspacePath: string }) =>
        scope.workspacePath === "/default" ? [] : [taskFor(key, identity)],
      listPinnedTasks: async () => [],
      listArchivedTasks: async () => [],
      listDeletedTaskIds: async () => [],
      listPinnedTaskIds: async () => [],
      onDynamicWorkspaceEvent: () => noEvent,
      renameTaskGroup: async (params: { groupId: string; title: string }) => {
        writes.push(`${key}:${params.groupId}`);
        return {
          id: params.groupId,
          title: params.title,
          color: "gray",
          createdAt: 1,
          updatedAt: 2,
        };
      },
    },
    worktreeService: {
      list: async (scope: { workspacePath: string }) => {
        reads.push(`tree:${key}`);
        return scope.workspacePath === "/default"
          ? []
          : [
              {
                id: `${key}-tree`,
                status: "ready",
                originalWorkspacePath: "/same",
                originalWorkspaceIdentity: identity,
                checkoutPath: `/trees/${key}`,
              } as WorktreeBinding,
            ];
      },
    },
  }) as unknown as IServiceAccessor;
const local = makeServices("local");
const services: IServiceAccessor = {
  ...local,
  settingService: {
    get: async () => settings,
    update: async () => {
      throw new Error("浏览器不能写桌面项目记录");
    },
  } as IServiceAccessor["settingService"],
  windowWorkspaceService: {
    getCatalog: async () => catalog,
    onDidChangeCatalog: changes.event,
  } as IServiceAccessor["windowWorkspaceService"],
  createWorkspaceServiceAccessor: (scope: WindowWorkspaceScope) => {
    if (scope.kind === "local") return local;
    const entry = catalog.find((entry) => entry.scope.remoteSessionId === scope.remoteSessionId);
    if (!entry) throw new Error("stale fixture source");
    return makeServices(entry.target.kind, scope.workspaceIdentity, scope.generation);
  },
  windowControllerService: {
    onDynamicControllerFrame: () => noEvent,
    subscribeControllerV4: async () => ({
      ack: { subscriptionId: "fixture", logEpoch: "fixture", seq: 0 },
    }),
    unsubscribeControllerV4: async () => {},
    listTaskList: async (query: LCodeTaskListQuery) => ({
      items: query.workspaceScopes.flatMap((scope) =>
        scope.workspacePath === "/default"
          ? []
          : [
              {
                ...taskFor(
                  catalog.find((entry) => entry.scope.workspaceIdentity === scope.workspaceIdentity)
                    ?.target.kind ?? "local",
                  scope.workspaceIdentity,
                ),
                sourceAvailability: "online",
                liveStatus: "completed",
              },
            ],
      ),
      total: 4,
      hasMore: false,
    }),
  } as IServiceAccessor["windowControllerService"],
};
Object.assign(window, {
  __catalogFixture: {
    reads,
    writes,
    disconnect() {
      catalog = catalog.map((entry) =>
        entry.target.kind === "wsl" ? { ...entry, sourceAvailability: "offline" } : entry,
      );
      changes.fire(catalog);
    },
    reconnect() {
      catalog = catalog.map((entry) =>
        entry.target.kind === "wsl"
          ? {
              ...entry,
              sourceAvailability: "online",
              scope: {
                ...entry.scope,
                remoteSessionId: `${entry.target.kind}-replacement`,
                generation: entry.scope.generation + 1,
              },
            }
          : entry,
      );
      changes.fire(catalog);
    },
  },
});

function Fixture() {
  const tabs = useTabStoreApi();
  const windowTabs = useTabStore((state) => state.tabs);
  const path = useTabStore((state) => state.activeWorkspacePath);
  const identity = useTabStore((state) => state.activeWorkspaceIdentity);
  const navigation = useRemoteBrowserNavigationPersistence({
    scope: "fixture-device",
    services,
    tabStoreApi: tabs,
  });
  const lifecycle = useTabPersistence({
    settingService: services.settingService,
    persistSession: false,
    syncRecentProjects: false,
    restorePersistedSession: navigation.restore,
  });
  const projects = useMemo(() => windowTabs.filter(isWorkspaceTab), [windowTabs]);
  const trees = useSidebarWorktrees(projects);
  const groups = useGroupedTaskView({ workspaceTabs: projects });
  const workspace = useLCodeSessionStore((state) =>
    state.getWorkspaceState(path ?? "/default", identity ?? undefined),
  );
  useEffect(() => {
    if (lifecycle.hasCompletedFullRestore && path) navigation.beginRemembering();
  }, [lifecycle.hasCompletedFullRestore, path, navigation.beginRemembering]);
  return (
    <main className="p-4 text-ui-base">
      <output data-testid="active-identity">{identity ?? "local"}</output>
      <output data-testid="active-task">{workspace.activeTaskId ?? "draft"}</output>
      <div>
        {projects
          .filter((tab) => tab.workspacePath !== "/default")
          .map((tab) => (
            <button
              key={tab.id}
              data-testid={`project-${tab.remoteTarget?.kind ?? "local"}`}
              onClick={() => {
                tabs.getState().activateTab(tab.id);
                useLCodeSessionStore
                  .getState()
                  .setActiveTaskId(
                    tab.workspacePath,
                    `${tab.remoteTarget?.kind ?? "local"}-task`,
                    tab.workspaceIdentity,
                  );
              }}
            >
              {tab.remoteTarget?.kind ?? "local"} project{" "}
              <span data-testid={`session-${tab.remoteTarget?.kind ?? "local"}`}>
                {tab.remoteSessionId ?? "offline"}
              </span>
            </button>
          ))}
      </div>
      <section data-testid="worktrees">
        {trees.entries.map((entry) => (
          <div key={entry.binding.id}>{entry.binding.id}</div>
        ))}
      </section>
      <section data-testid="groups">
        {groups.view.nodes.map((node) =>
          node.type === "group" ? (
            <button
              key={node.group.id}
              onClick={() => groups.renameGroup(node.group.id, `${node.group.title} renamed`)}
            >
              {node.group.title}
            </button>
          ) : null,
        )}
      </section>
      <output data-testid="errors">{trees.errors.join(",")}</output>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <LCodeIntlProvider initialLocale="zh-CN">
    <ServiceProvider services={services}>
      <TabStoreProvider>
        <Fixture />
      </TabStoreProvider>
    </ServiceProvider>
  </LCodeIntlProvider>,
);
