import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { IServiceAccessor, WorktreeBinding } from "@lcode/services";
import type { LCodeTaskMeta } from "@lcode/shared";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { TabStoreProvider } from "@/store/TabStoreProvider.js";
import { StoreProvider } from "@/store/StoreProvider.js";
import { LCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import {
  SidebarTaskModeTabs,
  type SidebarPrimaryTaskMode,
} from "@/WorkspaceSidebar/SidebarTaskModeTabs.js";
import { WorkspaceWorktreesSection } from "@/WorkspaceSidebar/WorkspaceWorktreesSection.js";
import { useSidebarWorktrees } from "@/hooks/useSidebarWorktrees.js";
import { useWorktreePreparation } from "@/hooks/useWorktreePreparation.js";
import { isWorktreeSidebarTask, isWorktreeSidebarWorkspace } from "@/lib/worktreeSidebar.js";
import {
  readSidebarTaskPreferences,
  persistSidebarTaskPreferences,
} from "@/lib/sidebarTaskPreferences.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { useLCodeSessionStore } from "@/store/lcodeSessionStore.js";
import { useDraftExecutionStore } from "@/store/draftExecutionStore.js";
import { createReviewWorkspaceFixture } from "./review-workspace-service.js";
import { platform } from "./git-backup-platform.js";
import "@/styles.css";

const noop = () => {};
const subscribe = () => ({ dispose: noop });
const broadcast = {
  onMessage: subscribe,
  send: async () => {},
} as unknown as import("@lcode/services").IBroadcastService;
const origin = "/fixture/repo";
const titleStorageKey = "worktree-sidebar-fixture-titles";
const storedTitles: Record<string, string> = JSON.parse(
  localStorage.getItem(titleStorageKey) ?? "{}",
);
const tabs = [
  { id: "project", kind: "workspace", workspacePath: origin, label: "普通原项目" },
  { id: "checkout", kind: "workspace", workspacePath: "/fixture/tree-a", label: "独立工作树项目" },
] as WorkspaceTabState[];
let bindings = ["a", "b"].map((key) => ({
  id: `tree-${key}`,
  taskId: `root-${key}`,
  requestId: key,
  originalWorkspacePath: origin,
  workspacePath: `/fixture/tree-${key}`,
  checkoutPath: `/fixture/tree-${key}`,
  branch: `worktree/task-${key}`,
  repositoryRoot: origin,
  commonDirectory: origin + "/.git",
  baseCommit: "base",
  targetBranch: "main",
  sourceFolderPaths: [],
  status: "ready",
  preparation: { stage: "ready" },
  createdAt: "now",
  updatedAt: "now",
})) as WorktreeBinding[];
let tasks = [
  { taskId: "ordinary", title: "普通任务" },
  { taskId: "root-a", title: "树 A 主会话", executionBindingId: "tree-a" },
  { taskId: "fork-a", title: "树 A 复用会话", executionBindingId: "tree-a" },
  { taskId: "root-b", title: "树 B 会话", executionBindingId: "tree-b" },
].map((task) => ({
  ...task,
  title: storedTitles[task.taskId] ?? task.title,
  workspacePath: origin,
  provider: "lcode",
  mode: "agent",
  createdAt: 1,
  updatedAt: 1,
  status: "completed",
})) as LCodeTaskMeta[];
const calls: Array<{ method: string; params: unknown }> = [];
let failDeletion = false;
// 创建路径夹具：prepare 只登记绑定，advance 才把状态推进到 ready，模拟 Host 在侧栏已挂载后才落盘。
let pendingCreation: { requestId: string; taskId: string } | null = null;
const services = {
  worktreeService: {
    list: async ({ workspacePath }: { workspacePath: string }) =>
      bindings.filter(
        (b) =>
          b.status !== "deleted" &&
          (b.originalWorkspacePath === workspacePath || b.workspacePath === workspacePath),
      ),
    getBinding: async ({ taskId, requestId }: { taskId?: string; requestId?: string }) =>
      bindings.find((b) => b.taskId === taskId || b.requestId === requestId) ?? null,
    getIntegration: async () => null,
    getCapabilities: async () => ({ supported: true, archive: true, create: true }),
    prepare: async (params: { requestId: string; taskId: string }) => {
      calls.push({ method: "prepare", params });
      pendingCreation = { requestId: params.requestId, taskId: params.taskId };
      return null;
    },
    archive: async (params: { bindingId: string; requestId: string; discard: unknown }) => {
      calls.push({ method: "archive", params });
      if (failDeletion) {
        failDeletion = false;
        throw new Error("fixture EBUSY retry");
      }
      const binding = bindings.find((b) => b.id === params.bindingId)!;
      binding.deletion = {
        requestId: params.requestId,
        sessionIds: tasks
          .filter((task) => task.executionBindingId === binding.id)
          .map((task) => task.taskId),
      };
      binding.status = "deleted";
      tasks = tasks.filter((task) => task.executionBindingId !== binding.id);
      return structuredClone(binding);
    },
  },
  gitService: createReviewWorkspaceFixture(),
  lcodeTaskService: {
    getTaskMeta: async ({ taskId }: { taskId: string }) =>
      tasks.find((task) => task.taskId === taskId) ?? null,
    onTaskUpdated: subscribe,
  },
  windowControllerService: {
    onDynamicControllerFrame: () => subscribe,
    subscribeControllerV4: async () => ({ ack: { subscriptionId: "fixture" } }),
    unsubscribeControllerV4: async () => {},
    listTaskList: async ({ kind }: { kind: string }) => ({
      items: kind === "pinned" || kind === "archived" ? [] : structuredClone(tasks),
      total: kind === "pinned" || kind === "archived" ? 0 : tasks.length,
      hasMore: false,
    }),
  },
} as unknown as IServiceAccessor;
useRemoteWorkspaceSessionStore.getState().registerBaseServices(services);
Object.assign(globalThis, {
  __worktreeSidebar: {
    calls,
    failNextDelete: () => {
      failDeletion = true;
    },
    publishTitles: () => {
      tasks = tasks.map((task) =>
        task.taskId === "ordinary"
          ? { ...task, title: "统一普通任务标题", updatedAt: Date.now() }
          : task.taskId === "root-a"
            ? { ...task, title: "统一工作树任务标题", updatedAt: Date.now() }
            : task,
      );
      // 模拟同一服务端标题投影在浏览器重载后返回，视图自身不持久化标题。
      localStorage.setItem(
        titleStorageKey,
        JSON.stringify(Object.fromEntries(tasks.map((task) => [task.taskId, task.title]))),
      );
      useLCodeSessionStore.getState().bumpTaskListVersion(origin);
    },
    facts: () => ({
      bindingIds: bindings.filter((b) => b.status !== "deleted").map((b) => b.id),
      taskIds: tasks.map((task) => task.taskId),
    }),
    startCreation: () => {
      pendingCreation = { requestId: "fixture-create-1", taskId: "root-new" };
      // Host 在侧栏已挂载之后才落盘 binding；列表只能靠创建侧广播的失效重读才能看见它。
      bindings = [
        ...bindings,
        {
          id: "tree-new",
          taskId: pendingCreation.taskId,
          requestId: pendingCreation.requestId,
          originalWorkspacePath: origin,
          workspacePath: "/fixture/tree-new",
          checkoutPath: "/fixture/tree-new",
          branch: "worktree/task-new",
          repositoryRoot: origin,
          commonDirectory: origin + "/.git",
          baseCommit: "base",
          targetBranch: "main",
          sourceFolderPaths: [],
          status: "preparing",
          preparation: { stage: "checkout" },
          createdAt: "now",
          updatedAt: "now",
        } as WorktreeBinding,
      ];
      useDraftExecutionStore.getState().begin(
        origin,
        "fixture-create-1",
        false,
        { mode: "worktree" },
        {
          commandId: "fixture-create-1",
          type: "createSession",
          payload: { firstInput: { text: "新工作树首条输入" } },
        } as never,
      );
    },
    // 替换对象而不是原地改状态：已渲染行必须靠新一次 owner 读取才能看到 ready。
    advanceCreation: () => {
      if (!pendingCreation) return;
      bindings = bindings.map((binding) =>
        binding.id === "tree-new"
          ? { ...binding, status: "ready", preparation: { stage: "ready" } }
          : binding,
      );
      tasks = [
        ...tasks,
        {
          taskId: pendingCreation.taskId,
          title: "新工作树会话",
          executionBindingId: "tree-new",
          workspacePath: origin,
          provider: "lcode",
          mode: "agent",
          createdAt: 2,
          updatedAt: 2,
          status: "completed",
        } as LCodeTaskMeta,
      ];
      // 真实环境由 Host 的 task_created 事件触发重查；夹具用同一版本号入口收敛任务行。
      useLCodeSessionStore.getState().bumpTaskListVersion(origin);
    },
  },
});

/** 只挂准备轮询：创建路径的失效广播由 useWorktreePreparation 自己发出。 */
function CreationProbe() {
  const draft = useDraftExecutionStore((state) => state.drafts[origin]);
  const requestId = draft?.creationEnvelope?.commandId ?? draft?.requestId;
  const state = useWorktreePreparation(origin, undefined, requestId, undefined, Boolean(requestId));
  useEffect(() => {
    Object.assign(globalThis, {
      __worktreeCreationProbe: { bindingStatus: state.binding?.status ?? null },
    });
  }, [state.binding?.status]);
  return null;
}

function Fixture() {
  useLCodeSessionStore((state) => state.workspaces[origin]?.taskListVersion);
  const trees = useSidebarWorktrees(tabs);
  const [mode, setMode] = useState<SidebarPrimaryTaskMode>(() =>
    readSidebarTaskPreferences().organizeBy === "worktrees" ? "worktrees" : "workspace",
  );
  const [selected, setSelected] = useState("");
  const ownedBindings = trees.entries.map((entry) => entry.binding);
  return (
    <main className="h-dvh max-w-sm overflow-y-auto bg-sidebar p-2 text-ui-base text-foreground">
      <SidebarTaskModeTabs
        value={mode}
        onValueChange={(value) => {
          const next = value as SidebarPrimaryTaskMode;
          setMode(next);
          persistSidebarTaskPreferences({
            organizeBy: next === "workspace" ? "project" : next,
            sortBy: "updated",
          });
        }}
      />
      <p data-testid="selected-chat">{selected}</p>
      <CreationProbe />
      {mode === "worktrees" ? (
        <WorkspaceWorktreesSection
          {...trees}
          workspaceTabs={tabs}
          activeWorkspacePath={origin}
          activeTaskId={null}
          taskSortBy="updated"
          onSelectTask={(_path, id) => setSelected(id)}
        />
      ) : (
        <div data-testid="ordinary-view">
          {mode === "workspace" ? (
            tabs
              .filter((tab) => !isWorktreeSidebarWorkspace(tab, ownedBindings))
              .map((tab) => <p key={tab.id}>{tab.label}</p>)
          ) : (
            <p>分组成员保持不变</p>
          )}
          {tasks
            .filter((task) => !isWorktreeSidebarTask(task, ownedBindings))
            .map((task) => (
              <p key={task.taskId}>{task.title}</p>
            ))}
        </div>
      )}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <ServiceProvider services={services}>
    <PlatformProvider platform={platform}>
      <LCodeIntlProvider initialLocale="zh-CN">
        <StoreProvider broadcastService={broadcast}>
          <TabStoreProvider>
            <TooltipProvider>
              <Fixture />
            </TooltipProvider>
          </TabStoreProvider>
        </StoreProvider>
      </LCodeIntlProvider>
    </PlatformProvider>
  </ServiceProvider>,
);
