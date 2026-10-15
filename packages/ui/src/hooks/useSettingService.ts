/**
 * useSettingService —— 设置服务 hooks
 */
import { useState, useEffect, useCallback } from "react";
import { APP_RUNTIME_PREFERENCES_CHANGED_BROADCAST_CHANNEL, type AppSettings } from "@lcode/shared";
import type { ISettingService, IServiceAccessor } from "@lcode/services";
import { useServices } from "./useServices.js";
import { usePlatform } from "./usePlatform.js";

type SettingsSnapshot = {
  settings: AppSettings | null;
  loading: boolean;
  error: unknown | null;
};
type SettingsRefreshResult = { success: true } | { success: false; error: unknown };

interface SettingsStore {
  snapshot: SettingsSnapshot;
  inflightRefresh: Promise<SettingsRefreshResult> | null;
  listeners: Set<(snapshot: SettingsSnapshot) => void>;
}

// SettingsPage 外层与模型配置页内层可能分别绑定 Local/Remote Service；
// 共享一份 snapshot/inflight 会让一次 Environment 的刷新结果覆盖另一份事实源。
// 按 Service 实例隔离 store，保持同一 Environment 内的组件共享，同时阻断跨 Environment 串写。
const stores = new WeakMap<object, SettingsStore>();
const unavailableSettingsStore: SettingsStore = {
  snapshot: {
    settings: null,
    loading: true,
    error: null,
  },
  inflightRefresh: null,
  listeners: new Set(),
};

function getSettingsStore(settingService: ISettingService | undefined): SettingsStore {
  if (
    !settingService ||
    (typeof settingService !== "object" && typeof settingService !== "function")
  ) {
    return unavailableSettingsStore;
  }
  const existing = stores.get(settingService);
  if (existing) {
    return existing;
  }
  const created: SettingsStore = {
    snapshot: {
      settings: null,
      loading: true,
      error: null,
    },
    inflightRefresh: null,
    listeners: new Set(),
  };
  stores.set(settingService, created);
  return created;
}

function emitSettingsSnapshot(store: SettingsStore) {
  for (const listener of store.listeners) {
    listener(store.snapshot);
  }
}

async function refreshSettingsStore(
  settingService: ISettingService | undefined,
  afterPending = false,
): Promise<SettingsRefreshResult | undefined> {
  const store = getSettingsStore(settingService);
  if (!settingService) {
    return;
  }
  if (store.inflightRefresh) {
    if (!afterPending) return store.inflightRefresh;
    // 位置迁移已提交时，旧请求可能已捕获提交前设置；等其结算后必须新读一次。
    await store.inflightRefresh;
    // 多个等待者必须重新进入同一复用分支，不能各发一次 get 并乱序覆盖快照。
    return refreshSettingsStore(settingService);
  }

  store.snapshot = {
    ...store.snapshot,
    loading: true,
    error: null,
  };
  emitSettingsSnapshot(store);

  store.inflightRefresh = (async (): Promise<SettingsRefreshResult> => {
    try {
      const result = await settingService.get();
      store.snapshot = {
        settings: result,
        loading: false,
        error: null,
      };
      emitSettingsSnapshot(store);
      return { success: true };
    } catch (error) {
      store.snapshot = {
        // 设置读取失败时保留旧快照，避免一次刷新错误把已可用的设置页降级为空状态。
        settings: store.snapshot.settings,
        loading: false,
        error,
      };
      emitSettingsSnapshot(store);
      return { success: false, error };
    }
  })().finally(() => {
    store.inflightRefresh = null;
  });

  return store.inflightRefresh;
}

/** 获取和更新应用设置 */
export function useSettings(servicesOverride?: IServiceAccessor) {
  const contextServices = useServices();
  const { broadcastService, settingService, lcodeAgentService } =
    servicesOverride ?? contextServices;
  const platform = usePlatform();
  const settingsStore = getSettingsStore(settingService);
  const [owned, setOwned] = useState({ store: settingsStore, snapshot: settingsStore.snapshot });
  // 原因：切换 Host 后 effect 才替换 state，首帧会读到旧 Host 设置并初始化新草稿。
  // 服务身份变化时同步读取新 owner 的快照，禁止旧 Environment 默认值跨边界进入会话。
  const snapshot = owned.store === settingsStore ? owned.snapshot : settingsStore.snapshot;

  const refresh = useCallback(
    async (options?: { afterPending?: boolean; throwOnError?: boolean }) => {
      const result = await refreshSettingsStore(settingService, options?.afterPending);
      // 原读取路径继续保留旧快照；提交方显式要求时才反馈本次读回错误。
      if (options?.throwOnError && result?.success === false) throw result.error;
    },
    [settingService],
  );

  useEffect(() => {
    const listener = (nextSnapshot: SettingsSnapshot) => {
      setOwned({ store: settingsStore, snapshot: nextSnapshot });
    };

    settingsStore.listeners.add(listener);
    setOwned({ store: settingsStore, snapshot: settingsStore.snapshot });
    void refresh();

    return () => {
      settingsStore.listeners.delete(listener);
    };
  }, [refresh, settingsStore]);

  useEffect(() => {
    return (
      platform.onSettingsChanged?.(() => {
        // 原生通知发生在设置提交后；提交前 get 晚到时不能把该旧快照当成本轮刷新完成。
        // 这里只读回服务，不再次 syncAppSettings，避免窗口间广播回环。
        void refresh({ afterPending: true });
      }) ?? (() => {})
    );
  }, [platform, refresh]);

  const update = useCallback(
    async (patch: Partial<AppSettings>) => {
      await settingService.update(patch);
      platform.syncAppSettings?.(patch);
      await refresh();
      if (
        typeof patch.askUserQuestionAutoResolutionEnabled === "boolean" ||
        typeof patch.modelIoFullRetentionEnabled === "boolean"
      ) {
        const preferences = {
          askUserQuestionAutoResolutionEnabled:
            patch.askUserQuestionAutoResolutionEnabled ??
            settingsStore.snapshot.settings?.askUserQuestionAutoResolutionEnabled !== false,
          modelIoFullRetentionEnabled:
            patch.modelIoFullRetentionEnabled ??
            settingsStore.snapshot.settings?.modelIoFullRetentionEnabled === true,
        };
        const syncResults = await Promise.allSettled([
          lcodeAgentService.syncAppRuntimePreferences(preferences),
        ]);
        const syncError = syncResults.find(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        )?.reason;
        await broadcastService.send({
          channel: APP_RUNTIME_PREFERENCES_CHANGED_BROADCAST_CHANNEL,
          payload: preferences,
        });
        if (syncError) {
          throw syncError;
        }
      }
    },
    [broadcastService, settingService, settingsStore, lcodeAgentService, platform, refresh],
  );

  return {
    settings: snapshot.settings,
    loading: snapshot.loading,
    error: snapshot.error,
    update,
    refresh,
  };
}

/** 最近项目列表的便捷 hook */
export function useRecentProjects() {
  const { settings, loading, update } = useSettings();
  return {
    recentProjects: settings?.recentProjects ?? [],
    loading,
    addProject: async (path: string) => {
      const current = settings?.recentProjects ?? [];
      const updated = [path, ...current.filter((p) => p !== path)].slice(0, 10);
      await update({ recentProjects: updated });
    },
  };
}
