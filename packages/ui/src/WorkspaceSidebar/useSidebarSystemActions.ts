import type { Dispatch, SetStateAction } from "react";
import { sidebarEntryKey } from "@lcode/shared";
import { useSidebarOrganization } from "@/hooks/useSidebarOrganization.js";
import type { SidebarWorktreesResult } from "@/hooks/useSidebarWorktrees.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { useSidebarText } from "./sidebarText.js";
import { projectRef, treeRef } from "./sidebarReferences.js";
import type { SidebarHeaderAction } from "./SidebarSectionHeader.js";
import type { UnifiedSidebarTreeProps } from "./UnifiedSidebarTree.js";

export function useSidebarSystemActions(
  props: UnifiedSidebarTreeProps,
  projects: WorkspaceTabState[],
  trees: SidebarWorktreesResult,
  isOpen: (id: string) => boolean,
  toggle: (id: string) => void,
  setExpanded: Dispatch<SetStateAction<Record<string, boolean>>>,
): Record<"projects" | "worktrees" | "chats", SidebarHeaderAction[]> {
  const organization = useSidebarOrganization()!;
  const text = useSidebarText();
  const { intl } = useLCodeIntl();
  const expand = (id: "projects" | "worktrees") =>
    setExpanded((current) => ({
      ...current,
      [id]: true,
      ...Object.fromEntries(
        (id === "projects" ? projects.map(projectRef) : trees.entries.map(treeRef)).map((ref) => [
          sidebarEntryKey(ref),
          true,
        ]),
      ),
    }));
  return {
    projects: [
      { label: text("addProject"), run: props.onOpenFolderFromWorkspaceMenu },
      ...(props.onOpenRemoteWorkspace
        ? [{ label: text("remoteProject"), run: props.onOpenRemoteWorkspace }]
        : []),
      { label: text("expand"), run: () => expand("projects") },
      {
        label: text("collapse"),
        run: () => {
          if (isOpen("projects")) toggle("projects");
        },
      },
    ],
    worktrees: [
      {
        label: text("manage"),
        run: () => organization.showDialog({ type: "target", purpose: "manage" }),
      },
      { label: text("refresh"), run: () => void trees.refresh() },
      { label: text("expand"), run: () => expand("worktrees") },
      {
        label: text("collapse"),
        run: () => {
          if (isOpen("worktrees")) toggle("worktrees");
        },
      },
    ],
    chats: [
      {
        label: intl.formatMessage({ id: "workspaceSidebar.newConversation" }),
        run: props.onCreateConversationTask,
      },
      { label: text(isOpen("chats") ? "collapse" : "expand"), run: () => toggle("chats") },
    ],
  };
}
