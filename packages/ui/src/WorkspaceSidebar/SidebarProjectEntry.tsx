import type { ComponentProps, Dispatch, SetStateAction } from "react";
import { sidebarEntryKey, type LCodeTaskMeta } from "@lcode/shared";
import type { WorktreeBinding } from "@lcode/services";
import type { SidebarWorktreesResult } from "@/hooks/useSidebarWorktrees.js";
import type { SidebarExecutionSetsResult } from "@/hooks/useSidebarExecutionSets.js";
import { useSidebarOrganization } from "@/hooks/useSidebarOrganization.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { WorkspaceSidebarItem } from "@/WorkspaceSidebarItem.js";
import { isWorktreeSidebarTask } from "@/lib/worktreeSidebar.js";
import { taskSidebarRef } from "@/lib/sidebarOrganization.js";
import { SidebarEntryInteraction } from "./SidebarEntryInteraction.js";
import { scopeKey, projectRef } from "./sidebarReferences.js";
import type { UnifiedSidebarTreeProps } from "./UnifiedSidebarTree.js";
import { useSidebarText } from "./sidebarText.js";

export function SidebarProjectEntry({
  tab,
  tasks,
  props,
  trees,
  sets,
  bindings,
  placement,
  showChats,
  open,
  toggle,
  limit,
  setLimits,
  dates,
  sortBy,
  activateTab,
  closeTab,
}: {
  tab: WorkspaceTabState;
  tasks: LCodeTaskMeta[];
  props: UnifiedSidebarTreeProps;
  trees: SidebarWorktreesResult;
  sets: SidebarExecutionSetsResult;
  bindings: WorktreeBinding[];
  placement: Set<string>;
  showChats: boolean;
  open: boolean;
  toggle(): void;
  limit: number;
  setLimits: Dispatch<SetStateAction<Record<string, number>>>;
  dates: boolean;
  sortBy: "created" | "updated";
  activateTab: ComponentProps<typeof WorkspaceSidebarItem>["activateTab"];
  closeTab: ComponentProps<typeof WorkspaceSidebarItem>["closeTab"];
}) {
  const organization = useSidebarOrganization()!;
  const text = useSidebarText();
  const ref = projectRef(tab),
    key = sidebarEntryKey(ref),
    scope = scopeKey(tab);
  const hasIndependentChats = organization.snapshot.sections.some((section) =>
    section.entries.some((entry) => entry.kind === "task" && scopeKey(entry.workspace) === scope),
  );
  const hasSets = sets.entries.some(
    (entry) => scopeKey(entry.origin) === scope && entry.snapshot.status !== "archived",
  );
  const children = tasks.filter(
    (task) =>
      scopeKey(task) === scope &&
      !isWorktreeSidebarTask(task, bindings) &&
      !placement.has(sidebarEntryKey(taskSidebarRef(task))),
  );
  return (
    <SidebarEntryInteraction entry={ref}>
      <ul>
        <WorkspaceSidebarItem
          tab={tab}
          isActiveWorkspace={scope === (props.workspaceIdentity || props.workspacePath)}
          isExpanded={showChats && open}
          activateTab={activateTab}
          closeTab={closeTab}
          toggleWorkspaceExpanded={() => {
            if (showChats) toggle();
          }}
          onStartDraftInWorkspace={props.onStartDraftInWorkspace}
          onSelectTask={props.onSelectTask}
          onRemoveLocalProject={props.onRemoveLocalProject}
          onStartCollaboration={
            sets.supported.includes(scope)
              ? () =>
                  props.onCreateTask({
                    targetWorkspace: tab,
                    createSource: "project",
                    newWorktree: true,
                  })
              : undefined
          }
          taskItems={children.slice(0, limit)}
          showTaskList={showChats}
          taskListLoading={false}
          taskListHasMore={children.length > limit}
          onShowMoreTasks={() => setLimits((current) => ({ ...current, [key]: limit + 20 }))}
          reconnectingRemoteWorkspaceKeys={props.reconnectingRemoteWorkspaceKeys}
          remoteWorkspaceErrorByWorkspaceKey={props.remoteWorkspaceErrorByWorkspaceKey}
          reconnectingRemoteWorkspaceLogsByWorkspaceKey={
            props.reconnectingRemoteWorkspaceLogsByWorkspaceKey
          }
          onReconnectRemoteWorkspace={props.onReconnectRemoteWorkspace}
          sourceReadError={trees.failures[scope] || sets.failures[scope]}
          sourceRefreshing={trees.loadingScopeKeys.includes(scope) || sets.loading.includes(scope)}
          onRefreshSource={() => {
            void trees.refresh(scope);
            void sets.refresh(scope);
          }}
          onOpenFileTree={props.onOpenFileTree}
          groupByDate={dates}
          taskSortBy={sortBy}
          preserveOrigin={
            hasIndependentChats ||
            hasSets ||
            trees.loading ||
            trees.unavailableScopeKeys.includes(scope) ||
            trees.entries.some((entry) => scopeKey(entry.origin) === scope)
          }
          removalBlockedReason={
            hasSets
              ? text("activeExecutionSet")
              : trees.loading || trees.unavailableScopeKeys.includes(scope)
                ? text("verifySource")
                : hasIndependentChats
                  ? text("dependentChats")
                  : undefined
          }
        />
      </ul>
    </SidebarEntryInteraction>
  );
}
