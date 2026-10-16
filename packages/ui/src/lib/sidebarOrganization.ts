import {
  sidebarEntryKey,
  type SidebarEntryRef,
  type SidebarMutation,
  type SidebarOrganization,
} from "@lcode/shared";
export function taskSidebarRef(task: {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
}): SidebarEntryRef {
  return {
    kind: "task",
    workspace: {
      workspacePath: task.workspacePath,
      ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
    },
    taskId: task.taskId,
  };
}
export function invertSidebarMutations(
  before: SidebarOrganization,
  mutations: SidebarMutation[],
): SidebarMutation[] {
  const inverse: SidebarMutation[] = [];
  for (const mutation of [...mutations].reverse()) {
    if (mutation.type === "import") continue;
    if (mutation.type === "create")
      inverse.push({ type: "remove", sectionId: mutation.section.id });
    if (mutation.type === "rename") {
      const section = before.sections.find((item) => item.id === mutation.sectionId);
      if (section) inverse.push({ type: "rename", sectionId: section.id, title: section.title });
    }
    if (mutation.type === "remove") {
      const index = before.sections.findIndex((item) => item.id === mutation.sectionId);
      const section = before.sections[index];
      if (section) inverse.push({ type: "create", section, index });
    }
    if (mutation.type === "reorder")
      inverse.push({
        type: "reorder",
        sectionId: mutation.sectionId,
        index: before.sections.findIndex((item) => item.id === mutation.sectionId),
      });
    if (mutation.type === "reorderRoot")
      inverse.push({
        type: "reorderRoot",
        kind: mutation.kind,
        entries: before.rootOrders.filter((entry) => entry.kind === mutation.kind),
      });
    if (mutation.type === "move") {
      inverse.push({ type: "move", entries: mutation.entries, sectionId: null });
      for (const section of before.sections)
        for (const [index, entry] of section.entries.entries()) {
          if (mutation.entries.some((item) => sidebarEntryKey(item) === sidebarEntryKey(entry)))
            inverse.push({ type: "move", entries: [entry], sectionId: section.id, index });
        }
    }
  }
  return inverse;
}
export function normalizeSidebarSelection(
  entries: SidebarEntryRef[],
  sectionEntries: SidebarEntryRef[] = [],
  parents = new Map<string, string>(),
) {
  const explicitTasks = new Set(
    sectionEntries.filter((item) => item.kind === "task").map(sidebarEntryKey),
  );
  const projects = new Set(
    entries.filter((item) => item.kind === "project").map((entry) => sidebarEntryKey(entry)),
  );
  const containers = new Set(entries.filter((entry) => entry.kind !== "task").map(sidebarEntryKey));
  return entries.filter(
    (entry) =>
      entry.kind !== "task" ||
      explicitTasks.has(sidebarEntryKey(entry)) ||
      (parents.has(sidebarEntryKey(entry))
        ? !containers.has(parents.get(sidebarEntryKey(entry))!)
        : !projects.has(sidebarEntryKey({ kind: "project", ...entry.workspace }))),
  );
}
export function sidebarInsertionIndex(
  current: SidebarEntryRef[],
  moving: SidebarEntryRef[],
  target: SidebarEntryRef,
): number | null {
  const keys = new Set(moving.map(sidebarEntryKey));
  if (keys.has(sidebarEntryKey(target))) return null;
  const index = current
    .filter((entry) => !keys.has(sidebarEntryKey(entry)))
    .findIndex((entry) => sidebarEntryKey(entry) === sidebarEntryKey(target));
  return index < 0 ? null : index;
}
