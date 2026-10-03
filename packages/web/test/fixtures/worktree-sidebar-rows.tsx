import { useMemo, useState } from "react";
import type { LCodeTaskMeta } from "@lcode/shared";
import { MemoTaskItem, TaskListItemContextMenuContent } from "@/TaskListItem.js";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu.js";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
} from "@/components/ui/dropdown-menu.js";
import { TaskForkMenu } from "@/TaskForkMenu.js";
import { GroupedTaskRow } from "@/workspace-grouped-tasks/task-row.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { GlobalExecutionPolicySettings } from "@/worktree/ExecutionPolicySettings.js";
import { useTabStoreApi } from "@/store/TabStoreProvider.js";

const noop = () => {};
const groups: [] = [];
const navigate = (workspacePath: string, taskId: string, workspaceIdentity?: string) =>
  Object.assign(window, { __forkNavigation: { workspacePath, taskId, workspaceIdentity } });
const baseTask: LCodeTaskMeta = {
  taskId: "sidebar-worktree",
  traceId: "fixture-sidebar",
  title: "Sidebar worktree session " + "long title ".repeat(15),
  workspacePath: "/fixture/repo",
  createdAt: 1,
  updatedAt: 1,
  mode: "edit",
  forkedFromTaskId: "parent",
};

export function WorktreeSidebarRows() {
  const [bindingId, setBindingId] = useState<string | undefined>();
  const tabStore = useTabStoreApi();
  const { intl } = useLCodeIntl();
  Object.assign(window, {
    __worktreeSidebarRows: {
      setBindingId,
      changeProject: () => tabStore.getState().addTab("/fixture/other"),
    },
  });
  const task = useMemo(() => ({ ...baseTask, executionBindingId: bindingId }), [bindingId]);
  const localTask = useMemo(
    () => ({ ...baseTask, taskId: "sidebar-local", title: "Local session" }),
    [],
  );
  return (
    <main className="w-full max-w-xl space-y-3 p-4" data-testid="sidebar-rows">
      {["default", "pinned", "timeline", "grouped", "overlay"].map((kind) => (
        <section key={kind} data-testid={`sidebar-row-${kind}`} className="min-w-0">
          {kind === "grouped" || kind === "overlay" ? (
            <GroupedTaskRow
              task={task}
              groups={groups}
              activeWorkspacePath={baseTask.workspacePath}
              activeTaskId={null}
              workspaceLabel="Fixture project"
              onSelectTask={navigate}
              onCloseTask={noop}
              onMoveTaskToGroup={noop}
              onMoveTaskToTop={noop}
              onStartRenameTask={noop}
              onArchiveTask={noop}
              onMarkTaskAsUnread={noop}
              dragOverlay={kind === "overlay"}
            />
          ) : (
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <ul>
                  <MemoTaskItem
                    workspacePath={baseTask.workspacePath}
                    task={task}
                    isPinned={kind === "pinned"}
                    isActive={false}
                    onSelectTask={noop}
                    onArchiveTaskInline={noop}
                    onCancelArchiveConfirm={noop}
                    isArchiveConfirming={false}
                    onTogglePinTask={noop}
                    onStartRenameTask={noop}
                    onArchiveTask={noop}
                    onMarkTaskAsUnread={noop}
                    variant={kind === "timeline" ? "timeline" : "default"}
                    intl={intl}
                  />
                </ul>
              </ContextMenuTrigger>
              <TaskListItemContextMenuContent
                workspacePath={task.workspacePath}
                task={task}
                isPinned={kind === "pinned"}
                intl={intl}
                onTogglePinTask={noop}
                onStartRenameTask={noop}
                onArchiveTask={noop}
                onMarkTaskAsUnread={noop}
                onForkCreated={navigate}
              />
            </ContextMenu>
          )}
        </section>
      ))}
      <section data-testid="sidebar-local-row">
        <GroupedTaskRow
          task={localTask}
          groups={groups}
          activeWorkspacePath={baseTask.workspacePath}
          activeTaskId={null}
          workspaceLabel="Fixture project"
          onSelectTask={navigate}
          onCloseTask={noop}
          onMoveTaskToGroup={noop}
          onMoveTaskToTop={noop}
          onStartRenameTask={noop}
          onArchiveTask={noop}
          onMarkTaskAsUnread={noop}
        />
      </section>
      <DropdownMenu>
        <DropdownMenuTrigger data-testid="fork-mobile-menu">更多</DropdownMenuTrigger>
        <DropdownMenuContent>
          <TaskForkMenu task={task} dropdown onCreated={navigate} />
        </DropdownMenuContent>
      </DropdownMenu>
      <GlobalExecutionPolicySettings />
    </main>
  );
}
