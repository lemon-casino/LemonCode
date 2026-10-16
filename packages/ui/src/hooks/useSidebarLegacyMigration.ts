import { useEffect, useMemo } from "react";
import { buildRemoteEnvironmentKey, type SidebarMutation } from "@lcode/shared";
import { useBaseWorkspaceServices } from "./useWorkspaceServices.js";
import { useSidebarOrganization } from "./useSidebarOrganization.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { buildWorkspaceServiceLookup } from "@/lib/workspaceServiceResolver.js";
import { taskSidebarRef } from "@/lib/sidebarOrganization.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { logger } from "@/logger.js";
import { isWorktreeSidebarTask } from "@/lib/worktreeSidebar.js";
import type { WorktreeBinding } from "@lcode/services";

export function useSidebarLegacyMigration(
  tabs: WorkspaceTabState[],
  bindings: WorktreeBinding[],
  worktreesLoading: boolean,
) {
  const base = useBaseWorkspaceServices();
  const organization = useSidebarOrganization()!;
  const sessionsById = useRemoteWorkspaceSessionStore((state) => state.sessionsById);
  const sessionIdByWorkspaceIdentity = useRemoteWorkspaceSessionStore(
    (state) => state.sessionIdByWorkspaceIdentity,
  );
  const sessionIdByWorkspacePath = useRemoteWorkspaceSessionStore(
    (state) => state.sessionIdByWorkspacePath,
  );
  const sources = useMemo(() => {
    const lookup = buildWorkspaceServiceLookup(tabs, base, {
      sessionsById,
      sessionIdByWorkspaceIdentity,
      sessionIdByWorkspacePath,
    });
    const result = new Map<
      string,
      {
        service: typeof base.lcodeTaskService;
        worktrees: typeof base.worktreeService;
        tabs: WorkspaceTabState[];
      }
    >();
    for (const tab of tabs) {
      const resolved = lookup.get(tab.workspaceIdentity?.trim() || tab.workspacePath);
      if (!resolved) continue;
      const session = resolved.remoteSessionId ? sessionsById[resolved.remoteSessionId] : null;
      const key = session?.target
        ? buildRemoteEnvironmentKey(session.target)
        : resolved.isRemoteWorkspace
          ? tab.workspaceIdentity!
          : "local";
      const source = result.get(key) ?? {
        service: resolved.services.lcodeTaskService,
        worktrees: resolved.services.worktreeService,
        tabs: [],
      };
      source.tabs.push(tab);
      result.set(key, source);
    }
    return result;
  }, [base, tabs, sessionsById, sessionIdByWorkspaceIdentity, sessionIdByWorkspacePath]);
  const imported = organization.snapshot.importedSources;
  const run = organization.run;
  const writable = organization.writable;
  useEffect(() => {
    if (!writable || worktreesLoading) return;
    let active = true;
    void (async () => {
      const mutations: SidebarMutation[] = [];
      for (const [source, value] of sources) {
        if (imported.includes(source)) continue;
        try {
          const view = await value.service.listGroupedTaskViewStructure({
            workspaceScopes: value.tabs,
          });
          const ordinaryMembers = new Set<string>();
          let cursor = 0;
          await Promise.all(
            Array.from({ length: Math.min(8, view.members.length) }, async () => {
              while (cursor < view.members.length) {
                const member = view.members[cursor++]!;
                const task = await value.service.getTaskMeta({
                  workspacePath: member.workspacePath,
                  workspaceIdentity: member.workspaceIdentity,
                  taskId: member.taskId,
                });
                const binding = task?.executionBindingId
                  ? null
                  : await value.worktrees?.getBinding({
                      workspacePath: member.workspacePath,
                      workspaceIdentity: member.workspaceIdentity,
                      taskId: member.taskId,
                    });
                // 旧普通分组会保存隐藏的工作树成员；只读迁移不能将它们重新显示为普通分区会话。
                if (!binding && !isWorktreeSidebarTask(task ?? member, bindings))
                  ordinaryMembers.add(JSON.stringify([member.workspaceKey, member.taskId]));
              }
            }),
          );
          const order = new Map(
            view.topLevelOrders
              .filter((item) => item.type === "group")
              .map((item) => [item.groupId, item.sortOrder]),
          );
          mutations.push({
            type: "import",
            source,
            sections: [...view.groups]
              .sort((a, b) => (order.get(a.id) ?? a.createdAt) - (order.get(b.id) ?? b.createdAt))
              .map((group) => ({
                id: `legacy:${encodeURIComponent(source)}:${group.id}`,
                title: group.title.trim().slice(0, 80) || "Section",
                entries: view.members
                  .filter(
                    (item) =>
                      item.groupId === group.id &&
                      ordinaryMembers.has(JSON.stringify([item.workspaceKey, item.taskId])),
                  )
                  .sort(
                    (a, b) =>
                      (a.sortOrder ?? Number.MAX_SAFE_INTEGER) -
                        (b.sortOrder ?? Number.MAX_SAFE_INTEGER) || b.addedAt - a.addedAt,
                  )
                  .map(taskSidebarRef),
              })),
          });
        } catch (error) {
          logger.debug("[SidebarOrganization] legacy source remains pending", { error });
        }
      }
      if (active && mutations.length) await run(mutations, false, true);
    })();
    return () => {
      active = false;
    };
  }, [sources, imported, writable, run, bindings, worktreesLoading]);
}
