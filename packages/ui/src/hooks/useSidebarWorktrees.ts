import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WorktreeBinding, IServiceAccessor } from "@lcode/services";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { useBaseWorkspaceServices } from "./useWorkspaceServices.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { useWorktreeLifecycleStore } from "@/store/worktreeLifecycleStore.js";
import { buildWorkspaceServiceLookup } from "@/lib/workspaceServiceResolver.js";
import { getErrorMessage } from "@/lib/errorMessage.js";

export interface SidebarWorktreeEntry {
  binding: WorktreeBinding;
  origin: WorkspaceTabState;
  sourceKey?: string;
}
export interface SidebarWorktreesResult {
  entries: SidebarWorktreeEntry[];
  loading: boolean;
  errors: string[];
  refresh: () => Promise<void>;
  lookup: Map<
    string,
    { services: IServiceAccessor; remoteSessionId?: string; isRemoteWorkspace: boolean }
  >;
}

/** 工作树列表只读投影；每个身份使用已有 Host attachment，断连不查询本机。 */
export function useSidebarWorktrees(tabs: WorkspaceTabState[]): SidebarWorktreesResult {
  const base = useBaseWorkspaceServices();
  const sessionsById = useRemoteWorkspaceSessionStore((s) => s.sessionsById);
  const sessionIdByWorkspaceIdentity = useRemoteWorkspaceSessionStore(
    (s) => s.sessionIdByWorkspaceIdentity,
  );
  const sessionIdByWorkspacePath = useRemoteWorkspaceSessionStore(
    (s) => s.sessionIdByWorkspacePath,
  );
  const revisions = useWorktreeLifecycleStore((s) => s.revisions);
  const lookup = useMemo(
    () =>
      buildWorkspaceServiceLookup(tabs, base, {
        sessionsById,
        sessionIdByWorkspaceIdentity,
        sessionIdByWorkspacePath,
      }),
    [tabs, base, sessionsById, sessionIdByWorkspaceIdentity, sessionIdByWorkspacePath],
  );
  const [state, setState] = useState<{
    entries: SidebarWorktreeEntry[];
    loading: boolean;
    errors: string[];
  }>({ entries: [], loading: true, errors: [] });
  const ticket = useRef(0);
  const refresh = useCallback(async () => {
    const own = ++ticket.current;
    setState((s) => ({ ...s, loading: true }));
    const results = await Promise.all(
      tabs.map(async (origin) => {
        const key = origin.workspaceIdentity?.trim() || origin.workspacePath;
        const service = lookup.get(key)?.services.worktreeService;
        if (!service)
          return {
            key,
            entries: [] as SidebarWorktreeEntry[],
            error:
              origin.workspaceIdentity || origin.remoteTarget || origin.remoteSessionId
                ? "remote-workspace-disconnected"
                : undefined,
          };
        try {
          const bindings = await service.list({
            workspacePath: origin.workspacePath,
            workspaceIdentity: origin.workspaceIdentity,
          });
          return {
            key,
            entries: bindings
              .filter((b) => b.status !== "deleted")
              .map((binding) => {
                const originKey =
                  binding.originalWorkspaceIdentity?.trim() || binding.originalWorkspacePath;
                const project = tabs.find(
                  (tab) => (tab.workspaceIdentity?.trim() || tab.workspacePath) === originKey,
                );
                // list 同时接受原项目与执行 scope；一棵树只按 owner 原项目展示一次，不能复制成两个树项。
                const canonicalOrigin = project ?? {
                  ...origin,
                  workspacePath: binding.originalWorkspacePath,
                  workspaceIdentity: binding.originalWorkspaceIdentity,
                  remoteSessionId: lookup.get(key)?.remoteSessionId,
                  label:
                    binding.originalWorkspacePath.replace(/\\/gu, "/").split("/").at(-1) ||
                    origin.label,
                };
                return { binding, origin: canonicalOrigin, sourceKey: project ? originKey : key };
              }),
            error: undefined,
          };
        } catch (error) {
          return { key, entries: [] as SidebarWorktreeEntry[], error: getErrorMessage(error) };
        }
      }),
    );
    if (own !== ticket.current) return;
    setState((previous) => {
      const entries = new Map<string, SidebarWorktreeEntry>();
      for (const result of results) {
        // owner 读取失败时保留同 scope 的已知分类，避免其它视图把工作树暂时当成普通项目。
        const values = result.error
          ? previous.entries.filter(
              (e) =>
                (e.sourceKey ?? (e.origin.workspaceIdentity?.trim() || e.origin.workspacePath)) ===
                result.key,
            )
          : result.entries;
        for (const entry of values)
          entries.set(
            JSON.stringify([
              entry.origin.workspaceIdentity?.trim() || entry.origin.workspacePath,
              entry.binding.id,
            ]),
            entry,
          );
      }
      return {
        entries: [...entries.values()],
        loading: false,
        errors: [...new Set(results.flatMap((r) => (r.error ? [r.error] : [])))],
      };
    });
  }, [tabs, lookup]);
  useEffect(() => {
    void refresh();
    return () => {
      ticket.current++;
    };
  }, [refresh, revisions]);
  const ownerLookup = useMemo(() => {
    const result = new Map(lookup);
    for (const entry of state.entries) {
      const key = entry.origin.workspaceIdentity?.trim() || entry.origin.workspacePath;
      const source = lookup.get(entry.sourceKey ?? key);
      if (source) result.set(key, source);
    }
    return result;
  }, [lookup, state.entries]);
  return { ...state, refresh, lookup: ownerLookup };
}
