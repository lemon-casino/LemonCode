import { useCallback, useMemo } from "react";
import { RefreshCw, Settings2 } from "lucide-react";
import type { LCodeTaskMeta } from "@lcode/shared";
import type { SidebarWorktreeEntry } from "@/hooks/useSidebarWorktrees.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { useOpenWorktreeSettings } from "@/hooks/useOpenWorktreeSettings.js";
import { useWorktreeSidebarStore } from "@/store/worktreeSidebarStore.js";
import { Button } from "@/components/ui/button.js";
import {
  WorkspaceTimelineTasksSection,
  type SidebarTimelineGroup,
} from "@/WorkspaceTimelineTasksSection.js";
import { isTaskInSidebarBinding, isWorktreeSidebarTask } from "@/lib/worktreeSidebar.js";
import type { buildWorkspaceServiceLookup } from "@/lib/workspaceServiceResolver.js";
import type { CreateTaskRequest } from "@/app-shell/types.js";
import { WorktreeSidebarRow, type WorktreeFileTarget } from "./WorktreeSidebarRow.js";

type SelectTask = (path: string, id: string, identity?: string) => void;

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
  onCreateTask,
  onOpenFileTree,
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
  onCreateTask?: (request?: CreateTaskRequest) => void;
  onOpenFileTree?: (target: WorktreeFileTarget) => void;
}) {
  const { intl } = useLCodeIntl();
  const openSettings = useOpenWorktreeSettings();
  const collapsed = useWorktreeSidebarStore((state) => state.collapsed);
  const toggle = useWorktreeSidebarStore((state) => state.toggle);
  const bindings = useMemo(() => entries.map((entry) => entry.binding), [entries]);
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
    (task: LCodeTaskMeta) => isWorktreeSidebarTask(task, bindings),
    [bindings],
  );
  const buildGroups = useCallback(
    (tasks: LCodeTaskMeta[]): SidebarTimelineGroup[] => {
      const assigned = new Set<LCodeTaskMeta>();
      const groups: SidebarTimelineGroup[] = entries.map((entry) => {
        const { binding, origin } = entry;
        const key = JSON.stringify([
          origin.workspaceIdentity?.trim() || origin.workspacePath,
          binding.id,
        ]);
        const items = tasks.filter(
          (task) => !assigned.has(task) && isTaskInSidebarBinding(task, binding),
        );
        for (const item of items) assigned.add(item);
        // 原始会话可能被置顶/归档或尚未加载，不能把另一个子会话的历史当作派生来源。
        const rootTask = items.find((item) => item.taskId === binding.taskId);
        return {
          key,
          label: null,
          items,
          collapsed: Boolean(collapsed[key]),
          header: (
            <WorktreeSidebarRow
              entry={entry}
              task={rootTask}
              collapsed={Boolean(collapsed[key])}
              onToggle={() => toggle(key)}
              available={lookup.has(origin.workspaceIdentity?.trim() || origin.workspacePath)}
              onCreateTask={onCreateTask}
              onOpenFileTree={onOpenFileTree}
              onSelectTask={onSelectTask}
            />
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
    [entries, collapsed, toggle, lookup, onCreateTask, onOpenFileTree, onSelectTask, intl],
  );
  return (
    <div data-testid="sidebar-worktrees-section" className="min-w-0 space-y-1">
      <div className="flex items-center gap-1 px-2 text-ui-base text-foreground-subtle">
        <span className="min-w-0 flex-1">
          {intl.formatMessage({ id: "workspaceSidebar.organizeWorktrees" })}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={intl.formatMessage({ id: "worktree.manage" })}
          onClick={() =>
            openSettings({
              workspacePath: activeWorkspacePath,
              workspaceIdentity: activeWorkspaceIdentity,
            })
          }
        >
          <Settings2 className="size-3.5" />
        </Button>
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
    </div>
  );
}
