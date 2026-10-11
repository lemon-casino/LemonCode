import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ProviderAccountQuota,
  ProviderUsageRequest,
  ProviderUsageSnapshot,
} from "@lcode/shared";
import { useServices } from "@/hooks/useServices.js";

/** 筛选和服务实例共同标识读取范围，晚到响应不能把上个账号的数据放回页面。 */
export function useProviderUsageStats(
  request: ProviderUsageRequest,
  options: { enabled?: boolean } = {},
) {
  const { usageStatsService: service } = useServices();
  const key = JSON.stringify(request);
  const enabled = options.enabled ?? true;
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{
    service: typeof service;
    key: string;
    snapshot: ProviderUsageSnapshot | null;
    loading: boolean;
    error: "workspace" | "unavailable" | null;
  }>({ service, key, snapshot: null, loading: true, error: null });
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    setState((previous) => ({
      service,
      key,
      snapshot: previous.service === service && previous.key === key ? previous.snapshot : null,
      loading: true,
      error: null,
    }));
    void service.getProviderUsageSnapshot(JSON.parse(key) as ProviderUsageRequest).then(
      (snapshot) => {
        if (current) setState({ service, key, snapshot, loading: false, error: null });
      },
      (error: unknown) => {
        if (!current) return;
        const unavailable = error instanceof Error && error.message.includes("no_active_workspace");
        setState({
          service,
          key,
          snapshot: null,
          loading: false,
          error: unavailable ? "workspace" : "unavailable",
        });
      },
    );
    return () => {
      current = false;
    };
  }, [service, key, revision, enabled]);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  return {
    ...(!enabled
      ? { snapshot: null, loading: false, error: null }
      : state.service === service && state.key === key
        ? state
        : { snapshot: null, loading: true, error: null }),
    refresh,
  };
}

export function useProviderAccountQuota(
  connectionId: string,
  accountRevision: number,
  refreshEpoch = 0,
) {
  const { providerAccountService: service } = useServices();
  const [refreshId, setRefreshId] = useState(0);
  const previousRead = useRef({ service, connectionId, refreshId, refreshEpoch });
  const [state, setState] = useState<{
    service: typeof service;
    connectionId: string;
    accountRevision: number;
    quota: ProviderAccountQuota | null;
    loading: boolean;
    error: boolean;
  }>({ service, connectionId, accountRevision, quota: null, loading: true, error: false });
  useEffect(() => {
    let current = true;
    // 强制刷新是一次操作，账号目录 revision 更新不能重复消费；切换 Host/账号也不能继承旧操作。
    const previous = previousRead.current;
    const force =
      previous.service === service &&
      previous.connectionId === connectionId &&
      (previous.refreshId !== refreshId || previous.refreshEpoch !== refreshEpoch);
    previousRead.current = { service, connectionId, refreshId, refreshEpoch };
    setState((previous) => ({
      service,
      connectionId,
      accountRevision,
      quota:
        previous.service === service &&
        previous.connectionId === connectionId &&
        previous.accountRevision === accountRevision
          ? previous.quota
          : null,
      loading: true,
      error: false,
    }));
    if (!service) {
      setState({
        service,
        connectionId,
        accountRevision,
        quota: null,
        loading: false,
        error: true,
      });
      return;
    }
    void service.getQuota(connectionId, force).then(
      (quota) => {
        if (current)
          setState({ service, connectionId, accountRevision, quota, loading: false, error: false });
      },
      () => {
        if (current)
          setState({
            service,
            connectionId,
            accountRevision,
            quota: null,
            loading: false,
            error: true,
          });
      },
    );
    return () => {
      current = false;
    };
  }, [service, connectionId, accountRevision, refreshId, refreshEpoch]);
  const refresh = useCallback(() => {
    setRefreshId((value) => value + 1);
  }, []);
  return {
    ...(state.service === service &&
    state.connectionId === connectionId &&
    state.accountRevision === accountRevision
      ? state
      : { quota: null, loading: true, error: false }),
    refresh,
  };
}
