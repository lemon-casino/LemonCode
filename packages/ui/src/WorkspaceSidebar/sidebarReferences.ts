import type { SidebarEntryRef } from "@lcode/shared";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import type { SidebarWorktreeEntry } from "@/hooks/useSidebarWorktrees.js";
import type { SidebarExecutionSetEntry } from "@/hooks/useSidebarExecutionSets.js";
export const scopeKey = (scope: { workspacePath: string; workspaceIdentity?: string }) =>
  scope.workspaceIdentity?.trim() || scope.workspacePath;
export const projectRef = (tab: WorkspaceTabState): SidebarEntryRef => ({
  kind: "project",
  workspacePath: tab.workspacePath,
  ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
  ...(tab.localProjectId ? { localProjectId: tab.localProjectId } : {}),
});
export const treeRef = (entry: SidebarWorktreeEntry): SidebarEntryRef => ({
  kind: "worktree",
  origin: {
    workspacePath: entry.origin.workspacePath,
    ...(entry.origin.workspaceIdentity
      ? { workspaceIdentity: entry.origin.workspaceIdentity }
      : {}),
  },
  bindingId: entry.binding.id,
});
export const executionSetRef = (entry: SidebarExecutionSetEntry): SidebarEntryRef => ({
  kind: "executionSet",
  origin: entry.snapshot.origin,
  executionSetId: entry.snapshot.id,
  projectId: entry.snapshot.projectContext.projectId,
});
