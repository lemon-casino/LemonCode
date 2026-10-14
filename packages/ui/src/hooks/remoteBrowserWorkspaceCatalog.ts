import { windowWorkspaceCatalogSchema, type WindowWorkspaceCatalogEntry } from "@lcode/shared";
import type { IServiceAccessor } from "@lcode/services";
import {
  bindRemoteWorkspaceIdentity,
  registerBaseWorkspaceServices,
  registerRemoteWorkspaceSession,
  unregisterRemoteWorkspaceSession,
} from "@/store/remoteWorkspaceSessionStore.js";
import { isWorkspaceTab, type TabStore } from "@/store/tabStore.js";

/** 浏览器目录是 Host 注册表的派生视图；不调用任何 connect/disposeRemoteSession。 */
export function createRemoteBrowserWorkspaceCatalog(services: IServiceAccessor, tabs: TabStore) {
  const owner = services.windowWorkspaceService;
  const factory =
    typeof services.createWorkspaceServiceAccessor === "function"
      ? services.createWorkspaceServiceAccessor.bind(services)
      : undefined;
  const current = new Map<string, WindowWorkspaceCatalogEntry>();
  let disposed = false;
  let revision = 0;
  function apply(raw: WindowWorkspaceCatalogEntry[], addTabs = true) {
    if (disposed) return;
    const catalog = windowWorkspaceCatalogSchema.parse(raw);
    const next = new Map<string, WindowWorkspaceCatalogEntry>();
    for (const entry of catalog) {
      const key = entry.scope.workspaceIdentity;
      if (entry.sourceAvailability === "online" || !next.has(key)) next.set(key, entry);
    }
    for (const [key, previous] of current) {
      const entry = next.get(key);
      if (JSON.stringify(entry) === JSON.stringify(previous)) continue;
      if (previous.sourceAvailability === "online")
        unregisterRemoteWorkspaceSession(previous.scope.remoteSessionId);
    }
    for (const [key, entry] of next) {
      const previous = current.get(key);
      if (
        entry.sourceAvailability === "online" &&
        factory &&
        JSON.stringify(entry) !== JSON.stringify(previous)
      ) {
        registerRemoteWorkspaceSession({
          sessionId: entry.scope.remoteSessionId,
          target: entry.target,
          workspacePath: entry.scope.workspacePath,
          workspaceIdentity: key,
          services: factory(entry.scope),
        });
        bindRemoteWorkspaceIdentity(key, entry.scope.remoteSessionId);
      }
      if (addTabs)
        tabs.getState().ensureWorkspaceTab(entry.scope.workspacePath, {
          workspaceIdentity: key,
          remoteTarget: entry.target,
          ...(entry.sourceAvailability === "online"
            ? { remoteSessionId: entry.scope.remoteSessionId }
            : {}),
        });
    }
    // mergeWorkspaceTabOptions 不会清除 undefined，离线必须明确清掉旧 session。
    tabs.setState((state) => ({
      tabs: state.tabs.map((tab) => {
        if (!isWorkspaceTab(tab) || !tab.workspaceIdentity) return tab;
        const entry = next.get(tab.workspaceIdentity);
        const id = entry?.sourceAvailability === "online" ? entry.scope.remoteSessionId : undefined;
        return tab.remoteSessionId === id ? tab : { ...tab, remoteSessionId: id };
      }),
    }));
    current.clear();
    for (const [key, entry] of next) current.set(key, entry);
  }
  registerBaseWorkspaceServices(services);
  const subscription =
    owner && factory
      ? owner.onDidChangeCatalog((catalog) => {
          revision += 1;
          apply(catalog);
        })
      : undefined;
  return {
    async prepare() {
      if (!owner || !factory) return;
      const startedAt = revision;
      const catalog = await owner.getCatalog();
      // 已订阅后发生的连接事件比在途读取新，不能让旧快照重新绑定退休的 session。
      if (!disposed && revision === startedAt) apply(catalog, false);
    },
    reconcile() {
      apply([...current.values()]);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      subscription?.dispose();
      for (const entry of current.values())
        if (entry.sourceAvailability === "online")
          unregisterRemoteWorkspaceSession(entry.scope.remoteSessionId);
      current.clear();
    },
  };
}
