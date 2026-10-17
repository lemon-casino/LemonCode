import { sidebarEntryKey, type LCodeTaskMeta, type SidebarOrganization } from "@lcode/shared";
import type { SidebarCatalogItem } from "@/hooks/useSidebarOrganization.js";
import type { SidebarContentFocus } from "@/lib/sidebarTaskPreferences.js";
import { taskSidebarRef } from "@/lib/sidebarOrganization.js";

/** 专注只投影导航，独立会话引用优先于容器继承，不能重复出现或写回组织事实。 */
export function projectSidebarFocus(
  focus: SidebarContentFocus,
  snapshot: SidebarOrganization,
  catalog: SidebarCatalogItem[],
  tasks: LCodeTaskMeta[],
) {
  const explicit = new Set(
    snapshot.sections.flatMap((section) => section.entries.map(sidebarEntryKey)),
  );
  const taskItems = catalog.filter((item) => item.ref.kind === "task");
  const uniqueTasks = new Map(tasks.map((task) => [sidebarEntryKey(taskSidebarRef(task)), task]));
  const children = new Map<string, typeof taskItems>();
  for (const item of taskItems) {
    if (!item.naturalParent || explicit.has(sidebarEntryKey(item.ref))) continue;
    const key = sidebarEntryKey(item.naturalParent);
    const entries = children.get(key) ?? [];
    entries.push(item);
    children.set(key, entries);
  }
  const sections = snapshot.sections
    .map((section) => ({
      ...section,
      entries: section.entries.flatMap((ref) => {
        if (focus === "all") return [ref];
        if (focus === "projects") return ref.kind === "project" ? [ref] : [];
        if (focus === "worktrees")
          return ref.kind === "worktree" || ref.kind === "executionSet" ? [ref] : [];
        return ref.kind === "task"
          ? [ref]
          : (children.get(sidebarEntryKey(ref)) ?? []).map((item) => item.ref);
      }),
    }))
    .filter((section) => focus === "all" || section.entries.length > 0);
  const placed = new Set(sections.flatMap((section) => section.entries.map(sidebarEntryKey)));
  return {
    sections,
    chats: [...uniqueTasks.values()].filter(
      (task) => !placed.has(sidebarEntryKey(taskSidebarRef(task))),
    ),
  };
}

export function sidebarTaskSourceLabels(catalog: SidebarCatalogItem[]) {
  const byKey = new Map(catalog.map((item) => [sidebarEntryKey(item.ref), item]));
  return new Map(
    catalog
      .filter((item) => item.ref.kind === "task")
      .map((item) => {
        const parent = item.naturalParent && byKey.get(sidebarEntryKey(item.naturalParent));
        return [
          sidebarEntryKey(item.ref),
          parent ? `${parent.label} · ${parent.detail}` : item.detail,
        ];
      }),
  );
}
