import { useCallback, useMemo, useState } from "react";
import { GitBranch, RefreshCw, Trash2 } from "lucide-react";
import type { LCodeTaskMeta } from "@lcode/shared";
import type { SidebarWorktreeEntry } from "@/hooks/useSidebarWorktrees.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { useTaskFork } from "@/hooks/useTaskFork.js";
import { useTabStoreApi } from "@/store/TabStoreProvider.js";
import { removeTaskFromTaskCaches } from "@/lib/taskListMetaSync.js";
import { useLCodeSessionStore } from "@/store/lcodeSessionStore.js";
import { Button } from "@/components/ui/button.js";
import {
  WorkspaceTimelineTasksSection,
  type SidebarTimelineGroup,
} from "@/WorkspaceTimelineTasksSection.js";
import { ProjectWorktreeManagementDialog } from "@/worktree/ProjectWorktreeManagementDialog.js";
import {
  isTaskInSidebarBinding,
  isWorktreeSidebarTask,
  isWorktreeSidebarWorkspace,
} from "@/lib/worktreeSidebar.js";
import type { buildWorkspaceServiceLookup } from "@/lib/workspaceServiceResolver.js";

type SelectTask = (path: string, id: string, identity?: string) => void;

function ReuseWorktreeSession({
  task,
  remoteSessionId,
  onSelect,
}: {
  task: LCodeTaskMeta;
  remoteSessionId?: string;
  onSelect: SelectTask;
}) {
  const { intl } = useLCodeIntl();
  const { fork, pending, resolved } = useTaskFork(task, remoteSessionId, onSelect);
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={pending || !resolved.rpcReady}
      onClick={() => void fork("same")}
    >
      {intl.formatMessage({ id: "worktree.sidebarReuse" })}
    </Button>
  );
}

export function WorkspaceWorktreesSection({
  workspaceTabs,
  entries,
  lookup,
  loading,
  errors,
  refresh,
  activeWorkspacePath,
  activeWorkspaceIdentity,
  activeTaskId,
  taskSortBy,
  onSelectTask,
}: {
  workspaceTabs: WorkspaceTabState[];
  entries: SidebarWorktreeEntry[];
  lookup: ReturnType<typeof buildWorkspaceServiceLookup>;
  loading: boolean;
  errors: string[];
  refresh: () => Promise<void>;
  activeWorkspacePath: string;
  activeWorkspaceIdentity?: string;
  activeTaskId: string | null;
  taskSortBy: "created" | "updated";
  onSelectTask: SelectTask;
}) {
  const { intl } = useLCodeIntl();
  const tabStore = useTabStoreApi();
  const [management, setManagement] = useState<{
    entry: SidebarWorktreeEntry;
    deleting: boolean;
  } | null>(null);
  const queryTabs = useMemo(() => {
    const scopes = new Map(
      workspaceTabs.map((tab) => [tab.workspaceIdentity?.trim() || tab.workspacePath, tab]),
    );
    for (const entry of entries)
      scopes.set(
        entry.origin.workspaceIdentity?.trim() || entry.origin.workspacePath,
        entry.origin,
      );
    return [...scopes.values()];
  }, [workspaceTabs, entries]);
  const taskFilter = useCallback(
    (task: LCodeTaskMeta) =>
      isWorktreeSidebarTask(
        task,
        entries.map((entry) => entry.binding),
      ),
    [entries],
  );
  const buildGroups = useCallback(
    (tasks: LCodeTaskMeta[]): SidebarTimelineGroup[] => {
      const assigned = new Set<LCodeTaskMeta>();
      const groups = entries.map((entry) => {
        const { binding, origin } = entry;
        const key = JSON.stringify([
          origin.workspaceIdentity?.trim() || origin.workspacePath,
          binding.id,
        ]);
        const items = tasks.filter(
          (task) => !assigned.has(task) && isTaskInSidebarBinding(task, binding),
        );
        for (const item of items) assigned.add(item);
        const rootTask = items.find((item) => item.taskId === binding.taskId);
        const available = lookup.has(origin.workspaceIdentity?.trim() || origin.workspacePath);
        return {
          key,
          label: null,
          items,
          header: (
            <div
              className="mt-2 min-w-0 rounded-md border border-border px-2 py-1"
              data-testid="sidebar-worktree"
              data-binding-id={binding.id}
            >
              <div className="flex min-w-0 items-center gap-1.5 text-ui-base">
                <GitBranch className="size-3.5 shrink-0 text-foreground-subtle" />
                <span className="min-w-0 flex-1 truncate" title={binding.branch}>
                  {binding.branch}
                </span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={intl.formatMessage({ id: "worktree.discard" })}
                  disabled={!available}
                  onClick={() => setManagement({ entry, deleting: true })}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
              <p
                className="truncate text-ui-sm text-foreground-subtle"
                title={binding.checkoutPath}
              >
                {origin.label} · {intl.formatMessage({ id: `worktree.binding.${binding.status}` })}
              </p>
              <p
                className="truncate text-ui-xs text-foreground-subtlest"
                title={binding.checkoutPath}
              >
                {binding.checkoutPath}
              </p>
              <div className="flex flex-wrap items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!available}
                  onClick={() => setManagement({ entry, deleting: false })}
                >
                  {intl.formatMessage({ id: "worktree.manage" })}
                </Button>
                {rootTask && binding.status === "ready" ? (
                  <ReuseWorktreeSession
                    task={rootTask}
                    remoteSessionId={origin.remoteSessionId}
                    onSelect={onSelectTask}
                  />
                ) : null}
              </div>
            </div>
          ),
        };
      });
      const unresolved = tasks.filter((task) => !assigned.has(task));
      if (unresolved.length)
        groups.push({
          key: "unresolved",
          label: null,
          items: unresolved,
          header: (
            <p className="px-3 pt-2 text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "worktree.sidebarUnresolved" })}
            </p>
          ),
        });
      return groups;
    },
    [entries, intl, lookup, onSelectTask],
  );
  const selectedServices = management
    ? lookup.get(
        management.entry.origin.workspaceIdentity?.trim() || management.entry.origin.workspacePath,
      )
    : undefined;
  return (
    <div data-testid="sidebar-worktrees-section" className="min-w-0 space-y-1">
      <div className="flex items-center justify-between px-2 text-ui-base text-foreground-subtle">
        <span>{intl.formatMessage({ id: "workspaceSidebar.organizeWorktrees" })}</span>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={loading}
          aria-label={intl.formatMessage({ id: "worktree.refresh" })}
          onClick={() => void refresh()}
        >
          <RefreshCw className="size-3.5" />
        </Button>
      </div>
      {errors.map((error) => (
        <p key={error} role="alert" className="break-words px-2 text-ui-sm text-destructive">
          {error === "remote-workspace-disconnected"
            ? intl.formatMessage({ id: "worktree.sidebarDisconnected" })
            : error}
        </p>
      ))}
      {loading && entries.length === 0 ? (
        <p role="status" className="px-2 text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "worktree.loading" })}
        </p>
      ) : null}
      <WorkspaceTimelineTasksSection
        workspaceTabs={queryTabs}
        activeWorkspacePath={activeWorkspacePath}
        activeWorkspaceIdentity={activeWorkspaceIdentity}
        activeTaskId={activeTaskId}
        taskSortBy={taskSortBy}
        taskRowVariant="default"
        onSelectTask={onSelectTask}
        taskFilter={taskFilter}
        buildGroups={buildGroups}
        emptyMessage={intl.formatMessage({ id: "worktree.noWorktrees" })}
      />
      {management && selectedServices ? (
        <ServiceProvider services={selectedServices.services}>
          <ProjectWorktreeManagementDialog
            key={JSON.stringify([management.entry.binding.id, management.deleting])}
            workspacePath={management.entry.origin.workspacePath}
            workspaceIdentity={management.entry.origin.workspaceIdentity}
            workspaceRemoteSessionId={selectedServices.remoteSessionId}
            open
            onOpenChange={(open) => {
              if (!open) setManagement(null);
            }}
            initialSessionId={management.entry.binding.taskId}
            initialDeleteRequested={management.deleting}
            onSelectSession={(id) =>
              onSelectTask(
                management.entry.origin.workspacePath,
                id,
                management.entry.origin.workspaceIdentity,
              )
            }
            onWorktreeDeleted={(binding) => {
              // owner 返回已删除事实后立即淘汰精确会话投影，避免迟到列表帧把它们显示为“绑定缺失”。
              for (const taskId of binding.deletion?.sessionIds ?? [binding.taskId]) {
                removeTaskFromTaskCaches({
                  workspacePath: binding.originalWorkspacePath,
                  workspaceIdentity: binding.originalWorkspaceIdentity,
                  taskId,
                });
                removeTaskFromTaskCaches({
                  workspacePath: binding.workspacePath,
                  workspaceIdentity: binding.workspaceIdentity,
                  taskId,
                });
              }
              useLCodeSessionStore
                .getState()
                .bumpTaskListVersion(
                  binding.originalWorkspacePath,
                  binding.originalWorkspaceIdentity,
                );
              useLCodeSessionStore
                .getState()
                .bumpTaskListVersion(binding.workspacePath, binding.workspaceIdentity);
              // 删除只关闭精确执行 scope 的 tab，不能关闭普通原项目或同路径另一个远端身份。
              for (const tab of tabStore.getState().tabs)
                if (tab.kind === "workspace" && isWorktreeSidebarWorkspace(tab, [binding]))
                  tabStore.getState().closeTab(tab.id);
              setManagement(null);
              void refresh();
            }}
          />
        </ServiceProvider>
      ) : null}
    </div>
  );
}
