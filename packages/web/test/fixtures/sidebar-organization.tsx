import { useLCodeStore } from "@/store/StoreProvider.js";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  buildRemoteWorkspaceIdentity,
  emptySidebarOrganization,
  sidebarOrganizationRequestSchema,
  type SidebarOrganization,
  type AppSettings,
} from "@lcode/shared";
import type { IServiceAccessor, WorktreeBinding } from "@lcode/services";
import { applySidebarMutations } from "../../../services/src/sidebar-organization/domain/transition.js";
import { WorkspaceSidebar } from "@/WorkspaceSidebar.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { TabStoreProvider, useTabStoreApi } from "@/store/TabStoreProvider.js";
import { StoreProvider } from "@/store/StoreProvider.js";
import { LCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { useLCodeSessionStore } from "@/store/lcodeSessionStore.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { useRemoteTimelineTaskStore } from "@/store/remoteTimelineTaskStore.js";
import { useWorktreeLifecycleStore } from "@/store/worktreeLifecycleStore.js";
import { ConfirmDialogHost } from "@/ConfirmDialog.js";
import { platform } from "./git-backup-platform.js";
import { services as defaults } from "./sidebar-file-tree-service.js";
import { createSidebarFixtureData } from "./sidebar-organization-data.js";
import { createHeldSidebarProjectCommands } from "./sidebar-project-service.js";
import { installSidebarExecutionSets } from "./sidebar-execution-set-service.js";
import { installSidebarMenuServices } from "./worktree-sidebar-menu-service.js";
import { installSidebarBasesFixture, SidebarBasesFixture } from "./sidebar-collaboration-bases.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import "@/styles.css";

const noop = () => {};
const subscribe = () => ({ dispose: noop });
const origin = "/fixture/repo";
const target = { kind: "ssh" as const, host: "example.invalid", username: "fixture", port: 22 };
const identity = buildRemoteWorkspaceIdentity(origin, target);
const params = new URLSearchParams(location.search);
let { tasks, bindings } = createSidebarFixtureData(origin, identity, target);
let snapshot: SidebarOrganization =
  JSON.parse(localStorage.getItem("sidebar-fixture-organization") || "null") ??
  emptySidebarOrganization();
if (params.has("empty")) {
  tasks = [];
  bindings = [];
}
const listeners = new Set<(state: SidebarOrganization) => void>();
const calls: Array<{ method: string; params: unknown }> = [];
const facts = {
  selected: "unchanged",
  drafts: 0,
  localReadsForRemote: 0,
  connects: 0,
  settingsSync: 0,
  creates: [] as unknown[],
  sourceReads: [] as string[],
};
const readFailures = new Map<string, string>();
const heldReads = new Map<string, (error?: string) => void>();
const holdNextReads = new Set<string>();
async function listWorktrees(scope: { workspacePath: string; workspaceIdentity?: string }) {
  const key = scope.workspaceIdentity || scope.workspacePath;
  facts.sourceReads.push(key);
  if (holdNextReads.delete(key))
    await new Promise<void>((resolve, reject) => {
      heldReads.set(key, (error) => {
        heldReads.delete(key);
        if (error) reject(new Error(error));
        else resolve();
      });
    });
  const error = readFailures.get(key);
  if (error) throw new Error(error);
  return bindings.filter(
    (binding) =>
      binding.originalWorkspaceIdentity === scope.workspaceIdentity &&
      binding.originalWorkspacePath === scope.workspacePath,
  );
}
const broadcast = { send: async () => {}, onMessage: subscribe } as never;
const settings: Partial<AppSettings> = JSON.parse(
  localStorage.getItem("sidebar-fixture-projects") || "null",
) ?? {
  recentProjects: [origin],
  localProjects: [
    { id: "project", name: "网站项目", primaryFolderPath: origin, sourceFolderPaths: [origin] },
  ],
  remoteWorkspaceSessions: [],
};
const projectCommands = createHeldSidebarProjectCommands(settings, calls);
const services = {
  ...defaults,
  broadcastService: broadcast,
  sidebarOrganizationService: {
    getSnapshot: async () => structuredClone(snapshot),
    onDidChange: (listener: (state: SidebarOrganization) => void) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    apply: async (raw: unknown) => {
      const input = sidebarOrganizationRequestSchema.parse(raw);
      calls.push({ method: "organize", params: input });
      if (input.expectedRevision !== snapshot.revision)
        return { status: "conflict", snapshot: structuredClone(snapshot) };
      snapshot = applySidebarMutations(snapshot, input.mutations);
      localStorage.setItem("sidebar-fixture-organization", JSON.stringify(snapshot));
      listeners.forEach((listener) => listener(structuredClone(snapshot)));
      return { status: "applied", snapshot: structuredClone(snapshot) };
    },
  },
  settingService: {
    ...defaults.settingService,
    get: async () => ({ ...(await defaults.settingService.get()), ...settings }),
    mutateProject: projectCommands.mutateProject,
  },
  fileService: {
    ...defaults.fileService,
    stat: async ({ path }: { path: string }) => {
      calls.push({ method: "localStat", params: { path } });
      if (path.includes("missing")) throw new Error("Fixture directory not found");
      return { type: "directory" };
    },
  },
  worktreeService: {
    ...defaults.worktreeService,
    list: listWorktrees,
    getBinding: async ({ taskId }: { taskId: string }) =>
      bindings.find(
        (binding) =>
          binding.taskId === taskId ||
          binding.id === tasks.find((task) => task.taskId === taskId)?.executionBindingId,
      ) ?? null,
    getCapabilities: async () => ({ supported: true, create: true, archive: true }),
  },
  lcodeTaskService: {
    ...defaults.lcodeTaskService,
    listGroupedTaskViewStructure: async () => ({ groups: [], members: [], topLevelOrders: [] }),
  },
  windowControllerService: {
    ...defaults.windowControllerService,
    listTaskList: async ({ kind }: { kind: string }) => {
      const items = tasks.filter(
        (task) =>
          !task.workspaceIdentity &&
          (kind === "archived"
            ? task.archivedAt
            : !task.archivedAt && (kind === "pinned" ? task.pinnedAt : !task.pinnedAt)),
      );
      return { items: structuredClone(items), total: items.length, hasMore: false };
    },
  },
} as IServiceAccessor;
installSidebarMenuServices(
  services,
  calls,
  () => tasks,
  (next) => {
    tasks = next;
    for (const task of next)
      useLCodeSessionStore
        .getState()
        .bumpTaskListVersion(task.workspacePath, task.workspaceIdentity);
  },
);
Object.assign(services.lcodeTaskService, {
  unarchiveTask: async ({ taskId }: { taskId: string }) => {
    tasks = tasks.map((task) =>
      task.taskId === taskId ? { ...task, archivedAt: undefined } : task,
    );
    useLCodeSessionStore.getState().bumpTaskListVersion(origin);
    return tasks.find((task) => task.taskId === taskId);
  },
  deleteTask: async ({ taskId }: { taskId: string }) => {
    calls.push({ method: "delete", params: { taskId } });
    tasks = tasks.filter((task) => task.taskId !== taskId);
  },
  deleteArchivedTasks: async ({
    taskIds,
    workspaceIdentity,
  }: {
    taskIds: string[];
    workspaceIdentity?: string;
  }) => {
    const deletedTaskIds = tasks
      .filter(
        (task) =>
          taskIds.includes(task.taskId) &&
          task.archivedAt &&
          task.workspaceIdentity === workspaceIdentity,
      )
      .map((task) => task.taskId);
    for (const taskId of deletedTaskIds) calls.push({ method: "delete", params: { taskId } });
    tasks = tasks.filter(
      (task) =>
        !deletedTaskIds.includes(task.taskId) || task.workspaceIdentity !== workspaceIdentity,
    );
    return {
      deletedTaskIds,
      skippedTaskIds: taskIds.filter((id) => !deletedTaskIds.includes(id)),
      failedTaskIds: [],
    };
  },
});
Object.assign(services.lcodeTaskService, {
  listTaskList: async () => ({
    items: tasks.filter(
      (task) => task.workspaceIdentity === identity && !task.archivedAt && !task.pinnedAt,
    ),
    total: 2,
    hasMore: false,
  }),
  listPinnedTasks: async () => ({ items: [], total: 0, hasMore: false }),
});
const remoteServices = {
  ...services,
  sidebarOrganizationService: undefined,
  fileService: {
    ...services.fileService,
    stat: async ({ path }: { path: string }) => {
      calls.push({ method: "remoteStat", params: { path, identity } });
      if (path.includes("missing")) throw new Error("Remote directory not found");
      return { type: "directory" };
    },
  },
  worktreeService: {
    ...services.worktreeService,
    list: listWorktrees,
  },
} as IServiceAccessor;
const executionSetFixtures = installSidebarExecutionSets(
  services,
  remoteServices,
  tasks,
  origin,
  identity,
  calls,
  params.has("sets"),
);
const { localSet, remoteSet } = executionSetFixtures;
tasks = executionSetFixtures.tasks;
const store = useRemoteWorkspaceSessionStore.getState();
store.registerBaseServices(services);
function registerRemote() {
  store.registerSession({
    sessionId: "remote",
    workspacePath: origin,
    workspaceIdentity: identity,
    target,
    services: remoteServices,
  });
  store.bindWorkspaceIdentity(identity, "remote");
}
registerRemote();
for (const task of tasks.filter((task) => task.workspaceIdentity))
  useRemoteTimelineTaskStore.getState().upsertTask(task);
const tabs: WorkspaceTabState[] = [
  {
    id: "project",
    kind: "workspace",
    workspacePath: origin,
    label: "网站项目",
    localProjectId: "project",
  },
  {
    id: "remote",
    kind: "workspace",
    workspacePath: origin,
    workspaceIdentity: identity,
    remoteSessionId: "remote",
    remoteTarget: target,
    label: "远程服务",
  },
  {
    id: "conversation",
    kind: "workspace",
    workspacePath: "/fixture/conversations",
    workspacePurpose: "conversation",
    label: "对话",
  },
];
Object.assign(globalThis, {
  __sidebarOrganization: {
    facts,
    calls,
    snapshot: () => snapshot,
    identity,
    origin,
    settings: () => settings,
    holdProjectSave: projectCommands.hold,
    releaseProjectSave: projectCommands.release,
    isProjectSaveHeld: projectCommands.pending,
    executionSets: () => [localSet.snapshot(), remoteSet.snapshot()],
    failExecutionSet: () => localSet.fail(),
    setReadError: (remote: boolean, error: string | null, refresh = true) => {
      const key = remote ? identity : origin;
      if (error) readFailures.set(key, error);
      else readFailures.delete(key);
      if (refresh) useWorktreeLifecycleStore.getState().invalidate(origin);
    },
    holdNextRead: () => holdNextReads.add(origin),
    releaseRead: (error?: string) => heldReads.get(origin)?.(error),
    hasHeldRead: () => heldReads.has(origin),
    online: registerRemote,
    offline: () => {
      useRemoteWorkspaceSessionStore.getState().unregisterSession("remote");
    },
    setStatus: (id: string, status: WorktreeBinding["status"]) => {
      bindings = bindings.map((binding) => (binding.id === id ? { ...binding, status } : binding));
      useWorktreeLifecycleStore.getState().invalidate(origin);
    },
    externalSection: () => {
      snapshot = applySidebarMutations(snapshot, [
        { type: "create", section: { id: "external", title: "其它窗口", entries: [] } },
      ]);
      listeners.forEach((listener) => listener(snapshot));
    },
  },
});
const theme = params.get("theme") || "zai-dark";
document.documentElement.classList.toggle("dark", ["zai-dark", "inkpurple"].includes(theme));
document.documentElement.classList.add(`theme-${theme}`);
function Fixture() {
  const api = useTabStoreApi();
  const [ready, setReady] = useState(false);
  const setTheme = useLCodeStore((state) => state.setTheme);
  useEffect(() => {
    setTheme(theme as never);
    api.setState({ tabs, activeTabId: "project", activeWorkspacePath: origin });
    setReady(true);
  }, [api, setTheme]);
  return (
    <main className="flex h-dvh bg-background text-foreground">
      {params.has("bases") ? <SidebarBasesFixture /> : null}
      <div className="w-80 max-w-full shrink-0 bg-sidebar">
        {ready ? (
          <WorkspaceSidebar
            workspacePath={origin}
            theme={theme as never}
            onSelectTask={(path, id, scope) => {
              facts.selected = `${path}:${id}:${scope || ""}`;
            }}
            onStartDraftInWorkspace={() => {
              facts.drafts++;
            }}
            onCreateTask={(request) => {
              facts.creates.push(request);
            }}
            onCreateConversationTask={() => {
              facts.drafts++;
            }}
            onOpenFolderFromWorkspaceMenu={noop}
            onConnectRemote={async () => "remote"}
            onSelectRemoteProject={async () => {}}
            onCancelRemoteProject={async () => {}}
            onReconnectRemoteWorkspace={async () => {
              facts.connects++;
            }}
            onOpenRemoteWorkspace={noop}
            reconnectingRemoteWorkspaceKeys={[]}
            remoteWorkspaceErrorByWorkspaceKey={{}}
            onOpenCommandCenter={noop}
            hideTopSpacer
          />
        ) : null}
      </div>
      <textarea
        aria-label="Composer"
        className="hidden sm:block m-4 h-24 min-w-0 flex-1 rounded-lg bg-input p-4"
        defaultValue="保持编辑焦点"
      />
    </main>
  );
}
installSidebarBasesFixture(services, calls);
createRoot(document.getElementById("root")!).render(
  <PlatformProvider
    platform={{
      ...platform,
      canSelectFilePath: true,
      selectDirectory: async () => "/fixture/backend",
      syncAppSettings: () => {
        facts.settingsSync++;
      },
    }}
  >
    <ServiceProvider services={services}>
      <StoreProvider broadcastService={broadcast}>
        <TabStoreProvider>
          <LCodeIntlProvider initialLocale={params.has("english") ? "en-US" : "zh-CN"}>
            <TooltipProvider>
              <Fixture />
              <ConfirmDialogHost />
            </TooltipProvider>
          </LCodeIntlProvider>
        </TabStoreProvider>
      </StoreProvider>
    </ServiceProvider>
  </PlatformProvider>,
);
