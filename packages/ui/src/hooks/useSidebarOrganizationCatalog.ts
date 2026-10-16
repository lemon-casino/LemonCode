import { useEffect, useMemo } from "react";
import { sidebarEntryKey, type LCodeTaskMeta } from "@lcode/shared";
import type { SidebarWorktreesResult } from "./useSidebarWorktrees.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { useSidebarOrganization, type SidebarCatalogItem } from "./useSidebarOrganization.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { useSidebarText } from "@/WorkspaceSidebar/sidebarText.js";
import { projectRef, treeRef, scopeKey } from "@/WorkspaceSidebar/sidebarReferences.js";
import { isTaskInSidebarBinding, isWorktreeSidebarTask } from "@/lib/worktreeSidebar.js";
import { taskSidebarRef } from "@/lib/sidebarOrganization.js";
export function useSidebarOrganizationCatalog(
  projects: WorkspaceTabState[],
  trees: SidebarWorktreesResult,
  allTasks: LCodeTaskMeta[],
) {
  const organization = useSidebarOrganization()!;
  const text = useSidebarText();
  const { intl, locale } = useLCodeIntl();
  const bindings = useMemo(() => trees.entries.map((entry) => entry.binding), [trees.entries]);
  const catalog = useMemo(() => {
    const items: SidebarCatalogItem[] = [
      ...projects.map((tab) => ({
        ref: projectRef(tab),
        available:
          tab.availability !== "unavailable-local-directory" && trees.lookup.has(scopeKey(tab)),
        label: tab.label,
        detail: `${text(tab.workspaceIdentity || tab.remoteTarget ? "remoteProject" : "localProject")} · ${tab.workspacePath}`,
      })),
      ...trees.entries.map((entry) => ({
        ref: treeRef(entry),
        available:
          entry.binding.status === "ready" &&
          trees.lookup.has(scopeKey(entry.origin)) &&
          !trees.unavailableScopeKeys.includes(scopeKey(entry.origin)),
        label: entry.binding.displayName || entry.binding.branch,
        detail: `${text(entry.origin.workspaceIdentity ? "remoteTree" : "localTree")} · ${entry.origin.label}`,
      })),
      ...allTasks.map((task) => ({
        ref: taskSidebarRef(task),
        naturalParent: (() => {
          const entry = trees.entries.find((entry) => isTaskInSidebarBinding(task, entry.binding));
          if (entry) return treeRef(entry);
          const project = projects.find((tab) => scopeKey(tab) === scopeKey(task));
          return !isWorktreeSidebarTask(task, bindings) && project
            ? projectRef(project)
            : undefined;
        })(),
        label: task.title || intl.formatMessage({ id: "taskList.untitled" }),
        detail: `${task.workspacePath}${task.workspaceIdentity ? ` · ${text("remoteProject")}` : ""}`,
      })),
    ];
    for (const section of organization.snapshot.sections)
      for (const ref of section.entries)
        if (!items.some((item) => sidebarEntryKey(item.ref) === sidebarEntryKey(ref)))
          items.push({
            ref,
            label:
              ref.kind === "task"
                ? ref.taskId
                : ref.kind === "worktree"
                  ? ref.bindingId
                  : ref.workspacePath.split(/[\\/]/).at(-1) || ref.workspacePath,
            detail: text("pendingSource"),
            available: false,
          });
    return items;
  }, [projects, trees.entries, allTasks, organization.snapshot.sections, intl, locale]);
  useEffect(() => organization.setCatalog(catalog), [catalog, organization.setCatalog]);
  return catalog;
}
