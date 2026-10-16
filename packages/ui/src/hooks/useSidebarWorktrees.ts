import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WorktreeBinding, IServiceAccessor } from "@lcode/services";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { sidebarEntryKey, type SidebarEntryRef } from "@lcode/shared";
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
  deletedReferences: SidebarEntryRef[];
  unavailableScopeKeys: string[];
  entries: SidebarWorktreeEntry[];
  loading: boolean;
  loadingScopeKeys: string[];
  failures: Record<string, string>;
  errors: string[];
  refresh: (scopeKey?: string) => Promise<void>;
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
    loadingScopeKeys: string[];
    failures: Record<string, string>;
    errors: string[];
    unavailableScopeKeys: string[];
    deletedReferences: SidebarEntryRef[];
  }>({
    entries: [],
    loading: true,
    loadingScopeKeys: [],
    failures: {},
    errors: [],
    unavailableScopeKeys: [],
    deletedReferences: [],
  });
  const tickets = useRef(new Map<string, number>());
  const refresh = useCallback(
    async (scope?: string) => {
      const currentKeys = new Set(
        tabs.map((tab) => tab.workspaceIdentity?.trim() || tab.workspacePath),
      );
      const requested = tabs.filter(
        (tab) => !scope || (tab.workspaceIdentity?.trim() || tab.workspacePath) === scope,
      );
      const requests = requested.map((origin) => {
        const key = origin.workspaceIdentity?.trim() || origin.workspacePath;
        const token = (tickets.current.get(key) ?? 0) + 1;
        tickets.current.set(key, token);
        return { origin, key, token };
      });
      setState((s) => {
        const loadingScopeKeys = [
          ...new Set([
            ...s.loadingScopeKeys.filter((key) => currentKeys.has(key)),
            ...requests.map((r) => r.key),
          ]),
        ];
        return { ...s, loading: loadingScopeKeys.length > 0, loadingScopeKeys };
      });
      const results = await Promise.all(
        requests.map(async ({ origin, key, token }) => {
          const service = lookup.get(key)?.services.worktreeService;
          if (!service)
            return {
              key,
              token,
              entries: [] as SidebarWorktreeEntry[],
              // 历史远端没有 attachment 属于正常未连接，不能伪造读取异常；仍保留已知工作树。
              unavailable: true,
              error: undefined,
            };
          try {
            const bindings = await service.list({
              workspacePath: origin.workspacePath,
              workspaceIdentity: origin.workspaceIdentity,
            });
            return {
              key,
              token,
              unavailable: false,
              entries: bindings.map((binding) => {
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
            return {
              key,
              token,
              unavailable: true,
              entries: [] as SidebarWorktreeEntry[],
              error: getErrorMessage(error) || String(error) || "Unknown error",
            };
          }
        }),
      );
      // 不同来源可以同时重新读取；仅丢弃同一来源过期的响应，不能让另一来源的刷新取消本次结果。
      const accepted = results.filter((result) => tickets.current.get(result.key) === result.token);
      if (!accepted.length && requests.length) return;
      setState((previous) => {
        const entries = new Map<string, SidebarWorktreeEntry>();
        const deleted = new Map<string, SidebarEntryRef>();
        const updatedKeys = new Set(accepted.map((result) => result.key));
        const sourceKey = (entry: SidebarWorktreeEntry) =>
          entry.sourceKey ?? (entry.origin.workspaceIdentity?.trim() || entry.origin.workspacePath);
        for (const entry of previous.entries)
          if (currentKeys.has(sourceKey(entry)) && !updatedKeys.has(sourceKey(entry)))
            entries.set(
              JSON.stringify([
                entry.origin.workspaceIdentity?.trim() || entry.origin.workspacePath,
                entry.binding.id,
              ]),
              entry,
            );
        for (const ref of previous.deletedReferences)
          if (
            ref.kind === "worktree" &&
            !updatedKeys.has(ref.origin.workspaceIdentity?.trim() || ref.origin.workspacePath)
          )
            deleted.set(sidebarEntryKey(ref), ref);
        const failures = Object.fromEntries(
          Object.entries(previous.failures).filter(
            ([key]) => currentKeys.has(key) && !updatedKeys.has(key),
          ),
        );
        const unavailableKeys = new Set(
          previous.unavailableScopeKeys.filter(
            (key) => currentKeys.has(key) && !updatedKeys.has(key),
          ),
        );
        for (const result of accepted) {
          if (result.error) failures[result.key] = result.error;
          if (result.unavailable) unavailableKeys.add(result.key);
          // owner 读取失败时保留同 scope 的已知分类，避免其它视图把工作树暂时当成普通项目。
          const values = result.unavailable
            ? previous.entries.filter(
                (e) =>
                  (e.sourceKey ??
                    (e.origin.workspaceIdentity?.trim() || e.origin.workspacePath)) === result.key,
              )
            : result.entries;
          for (const entry of values) {
            if (entry.binding.status === "deleted") {
              const ref: SidebarEntryRef = {
                kind: "worktree",
                origin: {
                  workspacePath: entry.origin.workspacePath,
                  ...(entry.origin.workspaceIdentity
                    ? { workspaceIdentity: entry.origin.workspaceIdentity }
                    : {}),
                },
                bindingId: entry.binding.id,
              };
              deleted.set(sidebarEntryKey(ref), ref);
              continue;
            }
            entries.set(
              JSON.stringify([
                entry.origin.workspaceIdentity?.trim() || entry.origin.workspacePath,
                entry.binding.id,
              ]),
              entry,
            );
          }
        }
        const loadingScopeKeys = previous.loadingScopeKeys.filter(
          (key) => currentKeys.has(key) && !updatedKeys.has(key),
        );
        return {
          entries: [...entries.values()],
          loading: loadingScopeKeys.length > 0,
          loadingScopeKeys,
          failures,
          errors: [...new Set(Object.values(failures))],
          unavailableScopeKeys: [...unavailableKeys],
          deletedReferences: [...deleted.values()],
        };
      });
    },
    [tabs, lookup],
  );
  useEffect(() => {
    void refresh();
    return () => {
      for (const [key, token] of tickets.current) tickets.current.set(key, token + 1);
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
