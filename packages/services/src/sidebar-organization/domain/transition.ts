import {
  sidebarEntryKey,
  sidebarOrganizationSchema,
  type SidebarMutation,
  type SidebarOrganization,
} from "@lcode/shared";

export function assertUniquePlacements(state: SidebarOrganization) {
  const sectionIds = new Set<string>();
  const entries = new Set<string>();
  for (const section of state.sections) {
    if (sectionIds.has(section.id)) throw new Error("Duplicate sidebar section");
    sectionIds.add(section.id);
    if (
      section.defaultTargetRef &&
      (section.defaultTargetRef.kind === "task" ||
        !section.entries.some(
          (entry) => sidebarEntryKey(entry) === sidebarEntryKey(section.defaultTargetRef!),
        ))
    )
      throw new Error("Invalid sidebar default target");
    for (const entry of section.entries) {
      const key = sidebarEntryKey(entry);
      if (entries.has(key)) throw new Error("Duplicate sidebar placement");
      entries.add(key);
    }
  }
}
export function applySidebarMutations(
  snapshot: SidebarOrganization,
  mutations: SidebarMutation[],
): SidebarOrganization {
  const next = structuredClone(snapshot);
  for (const mutation of mutations) {
    const requireSection = (sectionId: string) => {
      const section = next.sections.find((item) => item.id === sectionId);
      if (!section) throw new Error("Sidebar section no longer exists");
      return section;
    };
    switch (mutation.type) {
      case "editSection": {
        const target = requireSection(mutation.sectionId);
        const keys = new Set(mutation.entries.map(sidebarEntryKey));
        if (keys.size !== mutation.entries.length) throw new Error("Duplicate edit entries");
        if (
          mutation.defaultTargetRef &&
          (mutation.defaultTargetRef.kind === "task" ||
            !keys.has(sidebarEntryKey(mutation.defaultTargetRef)))
        )
          throw new Error("Invalid sidebar default target");
        for (const section of next.sections)
          section.entries = section.entries.filter((entry) => !keys.has(sidebarEntryKey(entry)));
        target.title = mutation.title;
        target.entries = structuredClone(mutation.entries);
        if (mutation.defaultTargetRef)
          target.defaultTargetRef = structuredClone(mutation.defaultTargetRef);
        else delete target.defaultTargetRef;
        break;
      }
      case "forget": {
        const keys = new Set(mutation.entries.map(sidebarEntryKey));
        for (const section of next.sections)
          section.entries = section.entries.filter((entry) => !keys.has(sidebarEntryKey(entry)));
        next.rootOrders = next.rootOrders.filter((entry) => !keys.has(sidebarEntryKey(entry)));
        break;
      }
      case "create":
        if (next.sections.some((section) => section.id === mutation.section.id))
          throw new Error("Sidebar section already exists");
        next.sections.splice(
          mutation.index ?? next.sections.length,
          0,
          structuredClone(mutation.section),
        );
        break;
      case "rename":
        requireSection(mutation.sectionId).title = mutation.title;
        break;
      case "remove":
        requireSection(mutation.sectionId);
        next.sections = next.sections.filter((section) => section.id !== mutation.sectionId);
        break;
      case "reorder": {
        const section = requireSection(mutation.sectionId);
        next.sections = next.sections.filter((item) => item !== section);
        next.sections.splice(mutation.index, 0, section);
        break;
      }
      case "reorderRoot": {
        if (
          mutation.entries.some((entry) => entry.kind !== mutation.kind) ||
          new Set(mutation.entries.map(sidebarEntryKey)).size !== mutation.entries.length
        )
          throw new Error("Invalid root order");
        next.rootOrders = [
          ...next.rootOrders.filter((entry) => entry.kind !== mutation.kind),
          ...structuredClone(mutation.entries),
        ];
        break;
      }
      case "move": {
        const target = mutation.sectionId === null ? null : requireSection(mutation.sectionId);
        const keys = new Set(mutation.entries.map(sidebarEntryKey));
        if (keys.size !== mutation.entries.length) throw new Error("Duplicate move entries");
        for (const section of next.sections)
          section.entries = section.entries.filter((entry) => !keys.has(sidebarEntryKey(entry)));
        target?.entries.splice(
          mutation.index ?? target.entries.length,
          0,
          ...structuredClone(mutation.entries),
        );
        break;
      }
      case "import": {
        if (next.importedSources.includes(mutation.source)) break;
        const placed = new Set(
          next.sections.flatMap((section) => section.entries.map(sidebarEntryKey)),
        );
        for (const section of mutation.sections) {
          if (next.sections.some((item) => item.id === section.id)) continue;
          const entries = section.entries.filter((entry) => {
            const key = sidebarEntryKey(entry);
            if (placed.has(key)) return false;
            placed.add(key);
            return true;
          });
          next.sections.push({ ...structuredClone(section), entries });
        }
        next.importedSources.push(mutation.source);
        break;
      }
    }
  }
  // 中文依据：默认入口只能指向分区直接成员；移出或跨区移动须随同一事务清空，避免新建误路由。
  for (const section of next.sections) {
    if (
      section.defaultTargetRef &&
      !section.entries.some(
        (entry) => sidebarEntryKey(entry) === sidebarEntryKey(section.defaultTargetRef!),
      )
    )
      delete section.defaultTargetRef;
  }
  next.revision++;
  if (next.sections.some((section) => section.entries.some((entry) => entry.kind === "executionSet")) || next.rootOrders.some((entry) => entry.kind === "executionSet")) next.version = 2;
  const validated = sidebarOrganizationSchema.parse(next);
  assertUniquePlacements(validated);
  return validated;
}
