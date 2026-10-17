import { useSidebarOrganizationCatalog } from "@/hooks/useSidebarOrganizationCatalog.js";
import { useSidebarTreePreferences } from "@/hooks/useSidebarTreePreferences.js";
import { useUnifiedSidebarSources } from "@/hooks/useUnifiedSidebarSources.js";
import { useUnifiedSidebarProjection } from "./useUnifiedSidebarProjection.js";
import { scopeKey, projectRef, treeRef, executionSetRef } from "./sidebarReferences.js";
import { useCallback, useMemo, useState } from "react";
import { Archive, ArrowLeft, Plus } from "lucide-react";
import { SidebarArchivePanel } from "./SidebarArchivePanel.js";
import { sidebarTaskSourceLabels } from "./sidebarFocusProjection.js";
import { taskSidebarRef } from "@/lib/sidebarOrganization.js";
import { sidebarEntryKey, type LCodeTaskMeta, type SidebarEntryRef } from "@lcode/shared";
import { useSidebarOrganization } from "@/hooks/useSidebarOrganization.js";
import { WorkspaceTimelineTasksSection } from "@/WorkspaceTimelineTasksSection.js";
import { WorkspacePinnedTasksSection } from "@/WorkspacePinnedTasksSection.js";
import { SidebarOrganizeMenu } from "./SidebarOrganizeMenu.js";
import { SidebarSortContextMenu } from "./SidebarSortContextMenu.js";
import { SidebarOrganizationDialog } from "./SidebarOrganizationDialog.js";
import { SidebarProjectEditor } from "./SidebarProjectEditor.js";
import { ProjectScopeDialog } from "./ProjectScopeDialog.js";
import { SidebarSectionHeader } from "./SidebarSectionHeader.js";
import { useSidebarText } from "./sidebarText.js";
import { Button } from "@/components/ui/button.js";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.js";
import { useOpenWorktreeSettings } from "@/hooks/useOpenWorktreeSettings.js";
import type { CreateTaskRequest } from "@/app-shell/types.js";
import type { RemoteConnectionLogEntry } from "@/hooks/useRemoteConnectionLogs.js";
import type { WorktreeFileTarget } from "./WorktreeSidebarRow.js";

export interface UnifiedSidebarTreeProps {
  workspacePath: string;
  workspaceIdentity?: string;
  activeTaskId: string | null;
  onSelectTask(
    path: string,
    taskId: string,
    identity?: string,
    remoteSessionId?: string,
    unreadAt?: number,
  ): void;
  onStartDraftInWorkspace(path: string, identity?: string): void;
  onCreateTask(request?: CreateTaskRequest): void;
  onCreateConversationTask(): void;
  onOpenFolderFromWorkspaceMenu(): void;
  onOpenRemoteWorkspace?: () => void;
  onRemoveLocalProject?: (
    request: import("@lcode/shared").LocalProjectRemoveRequest,
  ) => Promise<void>;
  onRemoveRemoteProject?: (workspaceKey: string) => Promise<void>;
  onReconnectRemoteWorkspace(key: string, options?: { cancelPending?: boolean }): Promise<void>;
  onCancelRemoteProject?(sessionId: string): Promise<void>;
  reconnectingRemoteWorkspaceKeys: string[];
  remoteWorkspaceErrorByWorkspaceKey: Record<string, string>;
  reconnectingRemoteWorkspaceLogsByWorkspaceKey: Record<string, RemoteConnectionLogEntry[]>;
  onOpenFileTree(target: WorktreeFileTarget): void;
}
export function UnifiedSidebarTree(props: UnifiedSidebarTreeProps) {
  const text = useSidebarText();
  const organization = useSidebarOrganization()!;
  const { projects, trees, sets, bindings, queryTabs, activateTab, closeTab } =
    useUnifiedSidebarSources();
  const {
    isOpen,
    toggle: togglePreference,
    setExpanded,
    sortBy,
    setSortBy,
    dates,
    setDates,
    focus,
    setFocus,
  } = useSidebarTreePreferences();
  const [allTasks, setAllTasks] = useState<LCodeTaskMeta[]>([]);
  const [hasPinnedTasks, setHasPinnedTasks] = useState(false);
  const [limits, setLimits] = useState<Record<string, number>>({});
  const toggle = (id: string) => {
    if (isOpen(id))
      setLimits((current) => {
        const keys = new Set([id]);
        const section = organization.snapshot.sections.find((section) => section.id === id);
        section?.entries.forEach((entry) => keys.add(sidebarEntryKey(entry)));
        if (id === "projects")
          projects
            .filter((tab) => !organization.sectionFor(projectRef(tab)))
            .forEach((tab) => keys.add(sidebarEntryKey(projectRef(tab))));
        if (id === "worktrees")
          trees.entries
            .filter((entry) => !organization.sectionFor(treeRef(entry)))
            .forEach((entry) => keys.add(sidebarEntryKey(treeRef(entry))));
        return Object.fromEntries(Object.entries(current).filter(([key]) => !keys.has(key)));
      });
    togglePreference(id);
  };
  const [archiveOpen, setArchiveOpen] = useState(false);
  const openWorktreeSettings = useOpenWorktreeSettings();
  const catalog = useSidebarOrganizationCatalog(projects, trees, allTasks, sets);
  const sourceLabels = useMemo(() => sidebarTaskSourceLabels(catalog), [catalog]);
  const placement = useMemo(
    () =>
      new Set(
        organization.snapshot.sections.flatMap((section) => section.entries.map(sidebarEntryKey)),
      ),
    [organization.snapshot],
  );
  const selectedTask = useCallback(
    (path: string, taskId: string, identity?: string, unreadAt?: number) =>
      props.onSelectTask(path, taskId, identity, undefined, unreadAt),
    [props.onSelectTask],
  );
  const createFor = (ref: SidebarEntryRef) => {
    if (ref.kind === "executionSet") {
      const entry = sets.entries.find(
        (entry) =>
          entry.snapshot.id === ref.executionSetId &&
          scopeKey(entry.origin) === scopeKey(ref.origin),
      );
      if (entry?.snapshot.status === "ready" && sets.supported.includes(scopeKey(entry.origin)))
        props.onCreateTask({
          targetWorkspace: entry.origin,
          createSource: "project",
          executionSetId: entry.snapshot.id,
        });
    }
    if (
      ref.kind === "project" &&
      trees.lookup.has(scopeKey(ref)) &&
      projects.find((tab) => scopeKey(tab) === scopeKey(ref))?.availability !==
        "unavailable-local-directory"
    )
      props.onStartDraftInWorkspace(ref.workspacePath, ref.workspaceIdentity);
    if (ref.kind === "worktree") {
      const entry = trees.entries.find(
        (item) => sidebarEntryKey(treeRef(item)) === sidebarEntryKey(ref),
      );
      if (
        entry?.binding.status === "ready" &&
        entry.binding.taskId &&
        trees.lookup.has(scopeKey(entry.origin)) &&
        !trees.unavailableScopeKeys.includes(scopeKey(entry.origin))
      )
        props.onCreateTask({
          targetWorkspace: entry.origin,
          createSource: "project",
          worktree: {
            bindingId: entry.binding.id,
            bindingOwnerTaskId: entry.binding.taskId,
            label: entry.binding.displayName || entry.binding.branch,
          },
        });
    }
  };
  const buildGroups = useUnifiedSidebarProjection({
    props,
    projects,
    trees,
    sets,
    bindings,
    catalog,
    placement,
    isOpen,
    toggle,
    setExpanded,
    limits,
    setLimits,
    dates,
    sortBy,
    focus,
    setFocus,
    hasPinnedTasks,
    selectedTask,
    activateTab,
    closeTab,
  });
  const expansion = (value: boolean | null) => {
    if (value !== true) setLimits({});
    setExpanded(
      value === null
        ? {}
        : Object.fromEntries(
            [
              "projects",
              "worktrees",
              "chats",
              "pinned",
              ...organization.snapshot.sections.map((section) => section.id),
              ...projects.map((tab) => sidebarEntryKey(projectRef(tab))),
              ...trees.entries.map((entry) => sidebarEntryKey(treeRef(entry))),
              ...sets.entries.map((entry) => sidebarEntryKey(executionSetRef(entry))),
            ].map((id) => [id, value]),
          ),
    );
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="unified-sidebar-tree">
      <div className="flex shrink-0 items-center gap-1 px-2 pt-1">
        {archiveOpen ? (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={text("backToWorkspace")}
            onClick={() => setArchiveOpen(false)}
          >
            <ArrowLeft className="size-3.5" />
          </Button>
        ) : null}
        <span className="min-w-0 flex-1 truncate pl-1 text-ui-sm font-medium text-foreground-subtlest">
          {text(archiveOpen ? "archived" : focus === "all" ? "workspace" : focus)}
        </span>
        <SidebarOrganizeMenu
          sortBy={sortBy}
          setSortBy={setSortBy}
          dates={dates}
          setDates={setDates}
          expand={expansion}
          focus={focus}
          setFocus={setFocus}
        />
        <Button
          data-testid="sidebar-archive-toggle"
          size="sm"
          variant="ghost"
          aria-pressed={archiveOpen}
          aria-controls="sidebar-archive-panel"
          className="shrink-0 gap-1 text-foreground-subtle aria-pressed:bg-selected aria-pressed:text-foreground"
          onClick={() => setArchiveOpen((open) => !open)}
        >
          <Archive className="size-3.5" />
          {text("archived")}
        </Button>
      </div>
      {organization.error ? (
        <p role="status" className="px-4 text-ui-sm text-foreground-subtle">
          {organization.error}
        </p>
      ) : null}
      {archiveOpen ? (
        <SidebarArchivePanel
          sets={sets}
          props={props}
          queryTabs={queryTabs}
          bindings={bindings}
          sortBy={sortBy}
        />
      ) : (
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
              {focus === "all" || focus === "chats" ? (
                <WorkspacePinnedTasksSection
                  header={
                    <SidebarSectionHeader
                      title={text("pinned")}
                      open={isOpen("pinned")}
                      toggle={() => toggle("pinned")}
                      actions={[
                        {
                          label: text(isOpen("pinned") ? "collapse" : "expand"),
                          run: () => toggle("pinned"),
                        },
                      ]}
                    />
                  }
                  collapsed={!isOpen("pinned")}
                  onHasItemsChange={setHasPinnedTasks}
                  showTitle={false}
                  workspaceTabs={queryTabs}
                  activeWorkspacePath={props.workspacePath}
                  activeWorkspaceIdentity={props.workspaceIdentity}
                  activeTaskId={props.activeTaskId}
                  taskSortBy={sortBy}
                  onSelectTask={selectedTask}
                  onOpenFileTree={props.onOpenFileTree}
                />
              ) : null}
              <WorkspaceTimelineTasksSection
                workspaceTabs={queryTabs}
                activeWorkspacePath={props.workspacePath}
                activeWorkspaceIdentity={props.workspaceIdentity}
                activeTaskId={props.activeTaskId}
                taskSortBy={sortBy}
                onSelectTask={selectedTask}
                taskRowVariant={focus === "chats" ? "timeline" : "default"}
                taskSourceLabel={
                  focus === "chats"
                    ? (task) => sourceLabels.get(sidebarEntryKey(taskSidebarRef(task)))
                    : undefined
                }
                emptyMessage={focus === "chats" && hasPinnedTasks ? "" : undefined}
                buildGroups={buildGroups}
                onItemsChange={setAllTasks}
              />
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem
              disabled={!organization.writable}
              onSelect={() => organization.showDialog({ type: "create" })}
            >
              {text("newSection")}
            </ContextMenuItem>
            <ContextMenuItem
              disabled={!organization.writable}
              onSelect={() => organization.setBatch(true)}
            >
              {text("batch")}
            </ContextMenuItem>
            <SidebarSortContextMenu
              sortBy={sortBy}
              setSortBy={setSortBy}
              dates={dates}
              setDates={setDates}
            />
            <ContextMenuItem onSelect={() => expansion(true)}>{text("expandAll")}</ContextMenuItem>
            <ContextMenuItem onSelect={() => expansion(false)}>
              {text("collapseAll")}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      )}
      {!archiveOpen && organization.batch ? (
        <div className="flex shrink-0 items-center justify-between gap-1 border-t border-border bg-sidebar p-2">
          <span className="text-ui-sm">
            {text("selected")} {organization.selected.length}
          </span>
          <Button
            size="sm"
            disabled={!organization.selected.length || !organization.writable}
            onClick={() =>
              organization.showDialog({ type: "move", entries: organization.selected })
            }
          >
            {text("move")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => organization.showDialog({ type: "add" })}
          >
            <Plus className="size-3" />
          </Button>
          <Button size="sm" variant="ghost" onClick={() => organization.setBatch(false)}>
            {text("cancel")}
          </Button>
        </div>
      ) : null}
      <SidebarOrganizationDialog
        onTarget={(entry) => {
          if (organization.dialog?.purpose === "manage") {
            if (entry.kind === "project") openWorktreeSettings(entry);
            else if (entry.kind === "worktree")
              openWorktreeSettings({ ...entry.origin, bindingId: entry.bindingId });
          } else createFor(entry);
        }}
      />
      {organization.projectEditor ? (
        <SidebarProjectEditor
          key={JSON.stringify([
            scopeKey(organization.projectEditor),
            organization.projectEditor.localProjectId,
          ])}
          target={organization.projectEditor}
        />
      ) : null}
      {organization.scopeTarget ? (
        <ProjectScopeDialog key={sidebarEntryKey(organization.scopeTarget)} />
      ) : null}
    </div>
  );
}
