import { sidebarEntryKey } from "@lcode/shared";
import { useEffect, useMemo } from "react";
import { useSidebarOrganization } from "./useSidebarOrganization.js";
import { useBaseWorkspaceServices } from "./useWorkspaceServices.js";
import { useSettings } from "./useSettingService.js";
import { useSidebarWorktrees } from "./useSidebarWorktrees.js";
import { resolveSessionConfigurationProjects } from "./useSessionConfigurationProjects.js";
import { useSidebarLegacyMigration } from "./useSidebarLegacyMigration.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab, type WorkspaceTabState } from "@/store/tabStore.js";
import { buildWorkspaceProjectMenuTabs } from "@/workspaceProjectMenu.js";
import { isWorktreeSidebarWorkspace } from "@/lib/worktreeSidebar.js";
import { scopeKey } from "@/WorkspaceSidebar/sidebarReferences.js";
export function useUnifiedSidebarSources() {
  const organization = useSidebarOrganization()!;
  const base = useBaseWorkspaceServices();
  const { settings } = useSettings(base);
  const tabs = useTabStore((state) => state.tabs);
  const activateTab = useTabStore((state) => state.activateTab);
  const closeTab = useTabStore((state) => state.closeTab);
  const workspaceTabs = useMemo(() => tabs.filter(isWorkspaceTab), [tabs]);
  const sessionsById = useRemoteWorkspaceSessionStore((state) => state.sessionsById);
  const sessionIdByWorkspaceIdentity = useRemoteWorkspaceSessionStore(
    (state) => state.sessionIdByWorkspaceIdentity,
  );
  const registeredTabs = useMemo(() => {
    const projects = resolveSessionConfigurationProjects({
      settings,
      workspaceTabs,
      worktreeEntries: [],
      sessionsById,
      sessionIdByWorkspaceIdentity,
    });
    return buildWorkspaceProjectMenuTabs({
      localProjects: settings?.localProjects ?? [],
      workspaceTabs: projects,
    }).map(
      (project): WorkspaceTabState => ({
        ...workspaceTabs.find((tab) => scopeKey(tab) === scopeKey(project)),
        ...project,
        kind: "workspace",
        id:
          workspaceTabs.find((tab) => scopeKey(tab) === scopeKey(project))?.id ??
          `sidebar:${scopeKey(project)}`,
      }),
    );
  }, [settings, workspaceTabs, sessionsById, sessionIdByWorkspaceIdentity]);
  const queryTabs = useMemo(
    () => [
      ...new Map([...registeredTabs, ...workspaceTabs].map((tab) => [scopeKey(tab), tab])).values(),
    ],
    [registeredTabs, workspaceTabs],
  );
  const trees = useSidebarWorktrees(queryTabs);
  useEffect(() => {
    if (!organization.writable) return;
    const confirmed = trees.deletedReferences.filter(
      (ref) =>
        organization.sectionFor(ref) ||
        organization.snapshot.rootOrders.some(
          (item) => sidebarEntryKey(item) === sidebarEntryKey(ref),
        ),
    );
    if (confirmed.length)
      void organization.run([{ type: "forget", entries: confirmed }], false, true);
  }, [trees.deletedReferences, organization]);
  const bindings = useMemo(() => trees.entries.map((entry) => entry.binding), [trees.entries]);
  const projects = useMemo(
    () =>
      registeredTabs.filter(
        (tab) =>
          tab.workspacePurpose !== "conversation" && !isWorktreeSidebarWorkspace(tab, bindings),
      ),
    [registeredTabs, bindings],
  );
  useSidebarLegacyMigration(queryTabs, bindings, trees.loading);
  return { projects, trees, bindings, queryTabs, activateTab, closeTab };
}
