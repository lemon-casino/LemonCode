import { ArchivedSidebarRow } from "@/WorkspaceSidebar/ArchivedSidebarRow.js";
import { useSidebarOrganization } from "@/hooks/useSidebarOrganization.js";
import { taskSidebarRef } from "@/lib/sidebarOrganization.js";
import { useEffect, useMemo, useState } from "react";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useGlobalTaskList } from "@/hooks/useGlobalTaskList.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { getPathLeaf } from "@/lib/path.js";
import { logger } from "@/logger.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { applyTaskQueryCacheMutation } from "@/store/taskQueryCacheStore.js";
import { removeTaskFromTaskCaches } from "@/lib/taskListMetaSync.js";
import { TaskListRemoteSyncHint } from "@/TaskListRemoteSyncHint.js";
import { TaskListLoadingHint } from "@/TaskListLoadingHint.js";
import { buildWorkspaceServiceLookup } from "@/lib/workspaceServiceResolver.js";
import { DeleteAllArchivedTasksButton } from "@/DeleteAllArchivedTasksButton.js";
import type { LCodeTaskMeta } from "@lcode/shared";

export function WorkspaceArchivedTasksFlatSection({
  workspaceTabs,
  activeWorkspacePath,
  activeWorkspaceIdentity,
  activeTaskId,
  sortBy,
  actionsContainer,
  onSelectTask,
  taskFilter,
  onDeleteActionChange,
  onRefreshActionChange,
}: {
  workspaceTabs: WorkspaceTabState[];
  activeWorkspacePath: string;
  activeWorkspaceIdentity?: string;
  activeTaskId: string | null;
  sortBy: "created" | "updated";
  taskFilter?: (task: LCodeTaskMeta) => boolean;
  onDeleteActionChange?: (action: { run(): void; enabled: boolean } | null) => void;
  onRefreshActionChange?: (action: (() => Promise<void>) | null) => void;
  actionsContainer?: HTMLElement | null;
  onSelectTask: (
    targetWorkspacePath: string,
    taskId: string,
    targetWorkspaceIdentity?: string,
  ) => void;
}) {
  const { intl } = useLCodeIntl();
  const confirmDialog = useConfirmDialog();
  const organization = useSidebarOrganization();
  const baseServices = useBaseWorkspaceServices();
  const sessionsById = useRemoteWorkspaceSessionStore((state) => state.sessionsById);
  const sessionIdByWorkspaceIdentity = useRemoteWorkspaceSessionStore(
    (state) => state.sessionIdByWorkspaceIdentity,
  );
  const sessionIdByWorkspacePath = useRemoteWorkspaceSessionStore(
    (state) => state.sessionIdByWorkspacePath,
  );
  const serviceResolverState = useMemo(
    () => ({
      sessionsById,
      sessionIdByWorkspaceIdentity,
      sessionIdByWorkspacePath,
    }),
    [sessionIdByWorkspaceIdentity, sessionIdByWorkspacePath, sessionsById],
  );
  const [showAllTasks, setShowAllTasks] = useState(false);
  const [deletingTaskKeys, setDeletingTaskKeys] = useState<Set<string>>(() => new Set());
  const collapsedLimit = 20;
  const workspaceLabelByKey = useMemo(
    () =>
      new Map(
        workspaceTabs.map(
          (tab) =>
            [
              buildTaskWorkspaceKey(tab.workspacePath, tab.workspaceIdentity),
              tab.label || getPathLeaf(tab.workspacePath),
            ] as const,
        ),
      ),
    [workspaceTabs],
  );

  const workspaceServiceLookup = useMemo(
    () => buildWorkspaceServiceLookup(workspaceTabs, baseServices, serviceResolverState),
    [baseServices, serviceResolverState, workspaceTabs],
  );
  const activeWorkspaceKey = buildTaskWorkspaceKey(activeWorkspacePath, activeWorkspaceIdentity);
  const {
    items: queriedItems,
    total: queriedTotal,
    loading,
    syncingRemoteWorkspaces,
    refresh,
  } = useGlobalTaskList({
    kind: "archived",
    workspaceTabs,
    sortBy,
    searchQuery: "",
    // 批量删除的选择集必须覆盖当前分类的完整行集合，不能被折叠上限截断；
    // 侧栏分类视图本来就走全量查询，这里显式固定，避免无 taskFilter 时删不到折叠外的行。
    expanded: true,
    collapsedLimit,
  });
  const classifiedItems = taskFilter ? queriedItems.filter(taskFilter) : queriedItems;
  const items = showAllTasks ? classifiedItems : classifiedItems.slice(0, collapsedLimit);
  const total = taskFilter ? classifiedItems.length : queriedTotal;
  const canToggleExpanded = total > collapsedLimit;
  useEffect(() => {
    onRefreshActionChange?.(refresh);
    return () => onRefreshActionChange?.(null);
  }, [refresh, onRefreshActionChange]);

  return (
    <div>
      {/* 批量删除与列表同源：传当前分类已渲染的行，避免删除侧重新查询原始行而漏掉工作树会话。 */}
      <DeleteAllArchivedTasksButton
        onDeletionCompleted={(targets) => {
          if (targets.length)
            void organization?.run(
              [{ type: "forget", entries: targets.map(taskSidebarRef) }],
              false,
              true,
            );
        }}
        onActionChange={onDeleteActionChange}
        visibleTasks={classifiedItems}
        actionsContainer={actionsContainer}
        count={total}
        disabled={loading || total === 0}
        workspaces={workspaceTabs.map((tab) => ({
          workspacePath: tab.workspacePath,
          workspaceIdentity: tab.workspaceIdentity,
          label: tab.label || getPathLeaf(tab.workspacePath),
          service: workspaceServiceLookup.get(
            buildTaskWorkspaceKey(tab.workspacePath, tab.workspaceIdentity),
          )?.services.lcodeTaskService,
        }))}
        onDeleted={removeTaskFromTaskCaches}
        onRefresh={refresh}
      />
      {items.length === 0 ? (
        loading ? (
          <TaskListLoadingHint />
        ) : (
          <div className="px-3 py-2 text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "taskList.noArchivedTasks" })}
          </div>
        )
      ) : null}
      <ul className="space-y-1 pb-4">
        {items.map((task) => {
          const workspaceServices = workspaceServiceLookup.get(
            buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity),
          );
          const services = workspaceServices?.services;
          const workspaceKey = buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity);
          const workspaceLabel =
            workspaceLabelByKey.get(workspaceKey) ?? getPathLeaf(task.workspacePath);
          const taskKey = `${workspaceKey}:${task.taskId}`;
          const restore = async () => {
            if (!services) return;
            try {
              const meta = await services.lcodeTaskService.unarchiveTask({
                taskId: task.taskId,
                workspacePath: task.workspacePath,
                ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
              });
              applyTaskQueryCacheMutation({
                previousTask: task,
                nextTask: meta,
                previousState: { pinned: false, archived: true },
                nextState: { pinned: false, archived: false },
              });
            } catch (error) {
              logger.error("[WorkspaceArchivedTasksFlatSection] unarchive failed", error);
            }
          };
          const remove = async () => {
            if (!services) return;
            const confirmed = await confirmDialog({
              title: intl.formatMessage({ id: "confirmDialog.archivedTaskDeleteTitle" }),
              description: intl.formatMessage({
                id: "confirmDialog.archivedTaskDeleteDescription",
              }),
              confirmLabel: intl.formatMessage({ id: "taskList.delete" }),
              confirmVariant: "destructive",
            });
            if (!confirmed) return;
            const currentSource = buildWorkspaceServiceLookup(
              workspaceTabs,
              baseServices,
              useRemoteWorkspaceSessionStore.getState(),
            ).get(workspaceKey);
            if (!currentSource) return;
            setDeletingTaskKeys((current) => new Set(current).add(taskKey));
            try {
              await currentSource.services.lcodeTaskService.deleteTask({
                taskId: task.taskId,
                workspacePath: task.workspacePath,
                ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
              });
              removeTaskFromTaskCaches({
                workspacePath: task.workspacePath,
                workspaceIdentity: task.workspaceIdentity,
                taskId: task.taskId,
              });
              void organization?.run(
                [{ type: "forget", entries: [taskSidebarRef(task)] }],
                false,
                true,
              );
            } catch (error) {
              logger.error("[WorkspaceArchivedTasksFlatSection] delete failed", error);
            } finally {
              setDeletingTaskKeys((current) => {
                const next = new Set(current);
                next.delete(taskKey);
                return next;
              });
            }
          };
          return (
            <ArchivedSidebarRow
              key={taskKey}
              task={task}
              label={workspaceLabel}
              active={workspaceKey === activeWorkspaceKey && task.taskId === activeTaskId}
              deleting={deletingTaskKeys.has(taskKey)}
              available={Boolean(workspaceServices)}
              sortBy={sortBy}
              open={() => onSelectTask(task.workspacePath, task.taskId, task.workspaceIdentity)}
              restore={() => void restore()}
              remove={() => void remove()}
            />
          );
        })}
      </ul>
      {syncingRemoteWorkspaces ? <TaskListRemoteSyncHint /> : null}
      {canToggleExpanded ? (
        <div className="cursor-pointer pl-8.5 pb-4">
          <span
            className="text-ui-base text-foreground-subtlest hover:text-foreground-subtle"
            onClick={() => {
              setShowAllTasks((current) => !current);
            }}
          >
            {intl.formatMessage({
              id: showAllTasks ? "taskList.showLess" : "taskList.showMore",
            })}
          </span>
        </div>
      ) : null}
    </div>
  );
}
