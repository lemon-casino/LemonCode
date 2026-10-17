import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { executionSetSnapshotSchema, type ExecutionSetSnapshot } from "@lcode/shared";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import type { SidebarWorktreesResult } from "./useSidebarWorktrees.js";
import { useWorktreeLifecycleStore } from "@/store/worktreeLifecycleStore.js";
import { scopeKey } from "@/WorkspaceSidebar/sidebarReferences.js";
import type { IServiceAccessor } from "@lcode/services";
export interface SidebarExecutionSetEntry {
  snapshot: ExecutionSetSnapshot;
  origin: WorkspaceTabState;
}
export function useSidebarExecutionSets(
  projects: WorkspaceTabState[],
  lookup: SidebarWorktreesResult["lookup"],
) {
  const [entries, setEntries] = useState<SidebarExecutionSetEntry[]>([]);
  const [failures, setFailures] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState<string[]>([]);
  const [supported, setSupported] = useState<string[]>([]);
  const revisions = useWorktreeLifecycleStore((state) => state.revisions);
  const tickets = useRef(new Map<string, number>());
  const capabilityOwners = useRef(
    new Map<string, IServiceAccessor["projectExecutionSetService"]>(),
  );
  const refresh = useCallback(
    async (scope?: string) => {
      const current = new Set(projects.map(scopeKey));
      const targets = projects.filter((project) => !scope || scopeKey(project) === scope);
      const requests = targets.map((origin) => {
        const key = scopeKey(origin),
          token = (tickets.current.get(key) ?? 0) + 1;
        tickets.current.set(key, token);
        return { origin, key, token };
      });
      setLoading((previous) => [
        ...new Set([
          ...previous.filter((key) => current.has(key)),
          ...requests.map((request) => request.key),
        ]),
      ]);
      for (let offset = 0; offset < requests.length; offset += 4)
        await Promise.all(
          requests.slice(offset, offset + 4).map(async ({ origin, key, token }) => {
            const service = lookup.get(key)?.services.projectExecutionSetService;
            let snapshots: ExecutionSetSnapshot[] | undefined;
            let reason: string | undefined;
            let available = false;
            try {
              if (service && (await service.capabilities()).protocolVersion === 1) {
                available = true;
                snapshots = (
                  await service.list({
                    workspacePath: origin.workspacePath,
                    workspaceIdentity: origin.workspaceIdentity,
                  })
                ).map((snapshot) => executionSetSnapshotSchema.parse(snapshot));
              }
            } catch (error) {
              // 中文依据：旧 Host 不支持能力协商属于不可用，已协商成功后的读取失败才归属具体项目。
              if (available) reason = error instanceof Error ? error.message : String(error);
            }
            if (tickets.current.get(key) !== token) return;
            if (available) capabilityOwners.current.set(key, service);
            else capabilityOwners.current.delete(key);
            setSupported((previous) => [
              ...previous.filter((item) => current.has(item) && item !== key),
              ...(available ? [key] : []),
            ]);
            setFailures((previous) => {
              const next = Object.fromEntries(
                Object.entries(previous).filter(([item]) => current.has(item) && item !== key),
              );
              if (reason) next[key] = reason;
              return next;
            });
            setEntries((previous) => [
              ...previous.filter(
                (entry) =>
                  current.has(scopeKey(entry.origin)) &&
                  (scopeKey(entry.origin) !== key || !snapshots),
              ),
              ...(snapshots?.map((snapshot) => ({ snapshot, origin })) ?? []),
            ]);
            setLoading((previous) => previous.filter((item) => current.has(item) && item !== key));
          }),
        );
    },
    [projects, lookup],
  );
  useEffect(() => {
    void refresh();
    return () => {
      for (const [key, token] of tickets.current) tickets.current.set(key, token + 1);
    };
  }, [refresh, revisions]);
  useEffect(() => {
    let active = true;
    const subscriptions: Array<{ dispose(): void }> = [];
    for (const origin of projects) {
      const service = lookup.get(scopeKey(origin))?.services.projectExecutionSetService;
      if (!service) continue;
      void service
        .capabilities()
        .then(() => {
          if (!active) return;
          subscriptions.push(
            service.onDidChange((raw) => {
              const parsed = executionSetSnapshotSchema.safeParse(raw);
              if (!active || !parsed.success || scopeKey(parsed.data.origin) !== scopeKey(origin))
                return;
              // 中文依据：订阅事件可能早于较旧 list 的响应；递增同来源代际，防止旧列表覆盖新准备进度。
              const key = scopeKey(origin);
              tickets.current.set(key, (tickets.current.get(key) ?? 0) + 1);
              setLoading((previous) => previous.filter((item) => item !== key));
              setSupported((previous) => [...new Set([...previous, key])]);
              capabilityOwners.current.set(key, service);
              setFailures((previous) => {
                const next = { ...previous };
                delete next[key];
                return next;
              });
              setEntries((previous) => {
                const current = previous.find(
                  (entry) =>
                    entry.snapshot.id === parsed.data.id &&
                    scopeKey(entry.origin) === scopeKey(origin),
                );
                if (current && current.snapshot.revision > parsed.data.revision) return previous;
                return [
                  ...previous.filter((entry) => entry !== current),
                  { snapshot: parsed.data, origin },
                ];
              });
            }),
          );
        })
        .catch(() => {
          /* 旧 Host 没有工作集事件；不建立另一份来源事实。 */
        });
    }
    return () => {
      active = false;
      subscriptions.forEach((subscription) => subscription.dispose());
    };
  }, [projects, lookup]);
  // 中文依据：catalog 会回写 Context；能力投影必须缓存，否则新数组会触发 catalog 更新回环。
  const currentSupported = useMemo(
    () =>
      supported.filter(
        (key) =>
          Boolean(lookup.get(key)?.services.projectExecutionSetService) &&
          capabilityOwners.current.get(key) ===
            lookup.get(key)?.services.projectExecutionSetService,
      ),
    [supported, lookup],
  );
  return {
    entries,
    failures,
    loading,
    supported: currentSupported,
    refresh,
    lookup,
  };
}
export type SidebarExecutionSetsResult = ReturnType<typeof useSidebarExecutionSets>;
