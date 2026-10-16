import { useEffect, useState } from "react";
import { readSidebarPurposeSectionPreferences } from "@/lib/sidebarPurposeSectionPreferences.js";
import { readGroupedTaskCollapsedGroupIds } from "@/lib/groupedTaskExpansionPreference.js";
import {
  persistSidebarTaskPreferences,
  readSidebarTaskPreferences,
} from "@/lib/sidebarTaskPreferences.js";
function readExpansion(): Record<string, boolean> {
  try {
    const saved = localStorage.getItem("lcode-sidebar-tree-expansion-v1");
    if (saved) {
      const parsed: unknown = JSON.parse(saved);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        return Object.fromEntries(
          Object.entries(parsed).filter(([, value]) => typeof value === "boolean"),
        );
    }
    const old = readSidebarPurposeSectionPreferences();
    return {
      projects: old.projectsExpanded,
      chats: old.conversationsExpanded,
      ...Object.fromEntries(
        [...readGroupedTaskCollapsedGroupIds()].map((id) => [`legacy:local:${id}`, false]),
      ),
    };
  } catch {
    return {};
  }
}
export function useSidebarTreePreferences() {
  const [expanded, setExpanded] = useState(readExpansion);
  const isOpen = (id: string) => expanded[id] ?? id !== "archived";
  const toggle = (id: string) =>
    setExpanded((current) => ({ ...current, [id]: !(current[id] ?? id !== "archived") }));
  useEffect(() => {
    try {
      localStorage.setItem("lcode-sidebar-tree-expansion-v1", JSON.stringify(expanded));
    } catch {
      /* 展开偏好不影响 owner 的组织事务。 */
    }
  }, [expanded]);
  const [sortBy, setSortBy] = useState(() => readSidebarTaskPreferences().sortBy);
  const [dates, setDates] = useState(
    () => readSidebarTaskPreferences().organizeBy === "chronological",
  );
  const [focus, setFocus] = useState(() => readSidebarTaskPreferences().focus);
  useEffect(
    () =>
      persistSidebarTaskPreferences({
        sortBy,
        organizeBy: dates ? "chronological" : "project",
        focus,
      }),
    [sortBy, dates, focus],
  );
  return { isOpen, toggle, setExpanded, sortBy, setSortBy, dates, setDates, focus, setFocus };
}
