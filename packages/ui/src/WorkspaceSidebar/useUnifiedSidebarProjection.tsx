import type { Dispatch, SetStateAction } from "react";
import type { ComponentProps } from "react";
import { sidebarEntryKey, type LCodeTaskMeta } from "@lcode/shared";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { useSidebarOrganization, type SidebarCatalogItem } from "@/hooks/useSidebarOrganization.js";
import type { SidebarWorktreesResult } from "@/hooks/useSidebarWorktrees.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import type { SidebarEntryRef } from "@lcode/shared";
import type { WorktreeBinding } from "@lcode/services";
import { WorkspaceSidebarItem } from "@/WorkspaceSidebarItem.js";
import type { SidebarTimelineGroup } from "@/WorkspaceTimelineTasksSection.js";
import { isTaskInSidebarBinding, isWorktreeSidebarTask } from "@/lib/worktreeSidebar.js";
import { taskSidebarRef } from "@/lib/sidebarOrganization.js";
import { groupTaskTimelineItems } from "@/lib/taskTimelineGroups.js";
import { SidebarEntryInteraction } from "./SidebarEntryInteraction.js";
import { SidebarSectionHeader } from "./SidebarSectionHeader.js";
import { SidebarUnavailableEntry } from "./SidebarUnavailableEntry.js";
import { WorktreeSidebarRow } from "./WorktreeSidebarRow.js";
import { Button } from "@/components/ui/button.js";
import { useSidebarText } from "./sidebarText.js";
import { scopeKey, projectRef, treeRef, executionSetRef } from "./sidebarReferences.js";
import { ExecutionSetSidebarRow } from "./ExecutionSetSidebarRow.js";
import type { UnifiedSidebarTreeProps } from "./UnifiedSidebarTree.js";
import type { SidebarContentFocus } from "@/lib/sidebarTaskPreferences.js";
import { projectSidebarFocus } from "./sidebarFocusProjection.js";
import { useSidebarSystemActions } from "./useSidebarSystemActions.js";
import { SidebarProjectEntry } from "./SidebarProjectEntry.js";
import type { SidebarExecutionSetsResult } from "@/hooks/useSidebarExecutionSets.js";
export function useUnifiedSidebarProjection({
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
}: {
  props: UnifiedSidebarTreeProps;
  projects: WorkspaceTabState[];
  trees: SidebarWorktreesResult;
  sets: SidebarExecutionSetsResult;
  bindings: WorktreeBinding[];
  catalog: SidebarCatalogItem[];
  placement: Set<string>;
  isOpen(id: string): boolean;
  toggle(id: string): void;
  setExpanded: Dispatch<SetStateAction<Record<string, boolean>>>;
  limits: Record<string, number>;
  setLimits: Dispatch<SetStateAction<Record<string, number>>>;
  dates: boolean;
  sortBy: "created" | "updated";
  focus: SidebarContentFocus;
  setFocus(value: SidebarContentFocus): void;
  hasPinnedTasks: boolean;
  selectedTask(path: string, taskId: string, identity?: string, unreadAt?: number): void;
  activateTab: ComponentProps<typeof WorkspaceSidebarItem>["activateTab"];
  closeTab: ComponentProps<typeof WorkspaceSidebarItem>["closeTab"];
}) {
  const organization = useSidebarOrganization()!;
  const text = useSidebarText();
  const { intl, locale } = useLCodeIntl();
  const systemActions = useSidebarSystemActions(
    props,
    projects,
    trees,
    isOpen,
    toggle,
    setExpanded,
  );
  const renderProject = (tab: WorkspaceTabState, tasks: LCodeTaskMeta[]) => {
    const key = sidebarEntryKey(projectRef(tab));
    return (
      <SidebarProjectEntry
        tab={tab}
        tasks={tasks}
        props={props}
        trees={trees}
        sets={sets}
        bindings={bindings}
        placement={placement}
        showChats={focus === "all"}
        open={isOpen(key)}
        toggle={() => toggle(key)}
        limit={limits[key] ?? 20}
        setLimits={setLimits}
        dates={dates}
        sortBy={sortBy}
        activateTab={activateTab}
        closeTab={closeTab}
      />
    );
  };
  const rootIndex = (ref: SidebarEntryRef) => {
    const index = organization.snapshot.rootOrders.findIndex(
      (item) => sidebarEntryKey(item) === sidebarEntryKey(ref),
    );
    return index < 0 ? Number.MAX_SAFE_INTEGER : index;
  };
  const unavailable = (ref: SidebarEntryRef, label: string): SidebarTimelineGroup => ({
    key: sidebarEntryKey(ref), label: null, items: [], header: <SidebarUnavailableEntry entry={ref} label={label} />,
  });
  const buildGroups = (tasks: LCodeTaskMeta[]): SidebarTimelineGroup[] => {
    const groups: SidebarTimelineGroup[] = [];
    const header = (
      id: string,
      title: string,
      section?: (typeof organization.snapshot.sections)[number],
      actions?: import("./SidebarSectionHeader.js").SidebarHeaderAction[],
    ) => {
      groups.push({
        key: `header:${id}`,
        label: null,
        items: [],
        header: (
          <SidebarSectionHeader
            title={title}
            open={isOpen(id)}
            toggle={() => toggle(id)}
            section={section}
            actions={actions}
            testId={
              id === "projects"
                ? "project-section"
                : id === "worktrees"
                  ? "sidebar-worktrees-section"
                  : undefined
            }
          />
        ),
      });
    };
    const addEntry = (ref: SidebarEntryRef, explicit = false) => {
      const key = sidebarEntryKey(ref);
      if (ref.kind === "project") {
        const tab = projects.find((item) => sidebarEntryKey(projectRef(item)) === key);
        if (tab) groups.push({ key, label: null, items: [], header: renderProject(tab, tasks) });
        else groups.push(unavailable(ref, catalog.find((item) => sidebarEntryKey(item.ref) === key)?.label || ref.workspacePath));
      } else if (ref.kind === "worktree") {
        const entry = trees.entries.find((item) => sidebarEntryKey(treeRef(item)) === key);
        if (entry) {
          const items =
            focus === "all"
              ? tasks.filter(
                  (task) =>
                    isTaskInSidebarBinding(task, entry.binding) &&
                    !placement.has(sidebarEntryKey(taskSidebarRef(task))),
                )
              : [];
          groups.push({
            key,
            label: null,
            indent: true,
            collapsed: focus !== "all" || !isOpen(key),
            header: (
              <SidebarEntryInteraction entry={ref}>
                <WorktreeSidebarRow
                  entry={entry}
                  task={tasks.find(
                    (task) =>
                      task.taskId === entry.binding.taskId &&
                      isTaskInSidebarBinding(task, entry.binding),
                  )}
                  collapsed={focus !== "all" || !isOpen(key)}
                  onToggle={focus === "all" ? () => toggle(key) : undefined}
                  available={
                    trees.lookup.has(scopeKey(entry.origin)) &&
                    !trees.unavailableScopeKeys.includes(scopeKey(entry.origin))
                  }
                  onCreateTask={props.onCreateTask}
                  onOpenFileTree={props.onOpenFileTree}
                  onSelectTask={selectedTask}
                  sourceReadError={trees.failures[entry.sourceKey ?? scopeKey(entry.origin)]}
                  sourceRefreshing={trees.loadingScopeKeys.includes(
                    entry.sourceKey ?? scopeKey(entry.origin),
                  )}
                  onRefreshSource={() =>
                    void trees.refresh(entry.sourceKey ?? scopeKey(entry.origin))
                  }
                />
              </SidebarEntryInteraction>
            ),
            items: dates ? [] : items.slice(0, limits[key] ?? 20),
          });
          if (dates && isOpen(key))
            groups.push(
              ...groupTaskTimelineItems(items.slice(0, limits[key] ?? 20), {
                sortBy,
                now: Date.now(),
                locale,
              }).map((group) => ({ ...group, key: `${key}:${group.key}`, indent: true })),
            );
          if (isOpen(key) && items.length > (limits[key] ?? 20))
            groups.push({
              key: `more:${key}`,
              label: null,
              items: [],
              header: (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    setLimits((current) => ({ ...current, [key]: (current[key] ?? 20) + 20 }))
                  }
                >
                  {intl.formatMessage({ id: "taskList.showMore" })}
                </Button>
              ),
            });
        } else
          groups.push({
            key,
            label: null,
            items: [],
            header: (
              <SidebarUnavailableEntry
                entry={ref}
                label={
                  catalog.find((item) => sidebarEntryKey(item.ref) === key)?.label || ref.bindingId
                }
              />
            ),
          });
      } else if (ref.kind === "executionSet") {
        const entry = sets.entries.find((entry) => sidebarEntryKey(executionSetRef(entry)) === key);
        if (entry && entry.snapshot.status !== "archived")
          groups.push({
            key,
            label: null,
            indent: true,
            collapsed: !isOpen(key),
            header: (
              <SidebarEntryInteraction entry={ref}>
                <ExecutionSetSidebarRow
                  entry={entry}
                  sets={sets}
                  open={isOpen(key)}
                  onToggle={() => toggle(key)}
                  props={props}
                />
              </SidebarEntryInteraction>
            ),
            items:
              focus === "all"
                ? tasks
                    .filter(
                      (task) =>
                        task.executionSetRef?.executionSetId === entry.snapshot.id &&
                        scopeKey(task.executionSetRef.origin) === scopeKey(entry.origin) &&
                        !placement.has(sidebarEntryKey(taskSidebarRef(task))),
                    )
                    .slice(0, limits[key] ?? 20)
                : [],
          });
        else if (!entry) groups.push(unavailable(ref, catalog.find((item) => sidebarEntryKey(item.ref) === key)?.label || ref.executionSetId));
      } else {
        const task = tasks.find((item) => sidebarEntryKey(taskSidebarRef(item)) === key);
        if (task) groups.push({ key, label: null, items: [task] });
        else if (explicit && !trees.lookup.has(scopeKey(ref.workspace)))
          groups.push({
            key,
            label: null,
            items: [],
            header: (
              <SidebarUnavailableEntry
                entry={ref}
                label={
                  catalog.find((item) => sidebarEntryKey(item.ref) === key)?.label || ref.taskId
                }
              />
            ),
          });
      }
    };
    const projected = projectSidebarFocus(focus, organization.snapshot, catalog, tasks);
    for (const section of projected.sections) {
      const first = groups.length;
      header(
        section.id,
        section.title,
        organization.snapshot.sections.find((item) => item.id === section.id),
      );
      if (isOpen(section.id)) for (const ref of section.entries) addEntry(ref, true);
      for (const group of groups.slice(first)) group.contextSectionId = section.id;
    }
    const rootProjects = projects
      .filter((tab) => !placement.has(sidebarEntryKey(projectRef(tab))))
      .sort((a, b) => rootIndex(projectRef(a)) - rootIndex(projectRef(b)));
    const rootTrees = trees.entries
      .filter((entry) => !placement.has(sidebarEntryKey(treeRef(entry))))
      .sort((a, b) => rootIndex(treeRef(a)) - rootIndex(treeRef(b)));
    const rootSets = sets.entries
      .filter(
        (entry) =>
          entry.snapshot.status !== "archived" &&
          !placement.has(sidebarEntryKey(executionSetRef(entry))),
      )
      .sort((a, b) => rootIndex(executionSetRef(a)) - rootIndex(executionSetRef(b)));
    const unresolved =
      focus === "all"
        ? tasks.filter(
            (task) =>
              isWorktreeSidebarTask(task, bindings) &&
              !trees.entries.some((entry) => isTaskInSidebarBinding(task, entry.binding)) &&
              !sets.entries.some(
                (entry) =>
                  task.executionSetRef?.executionSetId === entry.snapshot.id &&
                  scopeKey(task.executionSetRef.origin) === scopeKey(entry.origin),
              ) &&
              !placement.has(sidebarEntryKey(taskSidebarRef(task))),
          )
        : [];
    // 空分类以真实成员判断，不能因折叠或来源读取失败误删导航入口。
    if ((focus === "all" || focus === "projects") && rootProjects.length) {
      header("projects", text("projects"), undefined, systemActions.projects);
      if (isOpen("projects")) for (const tab of rootProjects) addEntry(projectRef(tab));
    }
    if (
      (focus === "all" || focus === "worktrees") &&
      (rootTrees.length || rootSets.length || unresolved.length)
    ) {
      header("worktrees", text("worktrees"), undefined, systemActions.worktrees);
      if (isOpen("worktrees")) {
        for (const entry of rootTrees) addEntry(treeRef(entry));
        for (const entry of rootSets) addEntry(executionSetRef(entry));
        if (unresolved.length)
          groups.push({
            key: "unresolved",
            label: null,
            items: unresolved,
            header: (
              <p className="px-3 text-ui-sm text-foreground-subtle">
                {intl.formatMessage({ id: "worktree.sidebarUnresolved" })}
              </p>
            ),
          });
      }
    }
    const chats =
      focus === "chats"
        ? projected.chats
        : tasks.filter(
            (task) =>
              !isWorktreeSidebarTask(task, bindings) &&
              !placement.has(sidebarEntryKey(taskSidebarRef(task))) &&
              !projects.some((tab) => scopeKey(tab) === scopeKey(task)),
          );
    if ((focus === "all" || focus === "chats") && chats.length) {
      header("chats", text("chats"), undefined, systemActions.chats);
      if (isOpen("chats")) {
        if (dates)
          groups.push(...groupTaskTimelineItems(chats, { sortBy, now: Date.now(), locale }));
        else groups.push({ key: "chats", label: null, items: chats });
      }
    }
    if (focus !== "all" && !groups.length && !(focus === "chats" && hasPinnedTasks))
      groups.push({
        key: "focus-empty",
        label: null,
        items: [],
        header: (
          <div
            role="status"
            className="flex flex-col items-center gap-2 px-3 py-6 text-ui-sm text-foreground-subtle"
          >
            <p>{text("noItems")}</p>
            <Button variant="ghost" size="sm" onClick={() => setFocus("all")}>
              {text("showAll")}
            </Button>
          </div>
        ),
      });
    return groups;
  };
  return buildGroups;
}
