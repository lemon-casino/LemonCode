import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AppUsageRange,
  AppUsageSnapshot,
  UsageStatsRange,
  UsageStatsSnapshot,
  LCodeAccountAccess,
  LCodeProviderAccountAccess,
} from "@lcode/shared";
import { logger } from "@/logger.js";
import { useServices } from "@/hooks/useServices.js";
import { useStableAccountAccess } from "@/hooks/useStableAccountAccess.js";

interface UsageStatsState {
  snapshot: UsageStatsSnapshot | null;
  loading: boolean;
  error: string | null;
}

interface AppUsageStatsState {
  snapshot: AppUsageSnapshot | null;
  loading: boolean;
  error: string | null;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name || String(error);
  }
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
  }
  return String(error);
}

const INITIAL_STATE: UsageStatsState = {
  snapshot: null,
  loading: false,
  error: null,
};

export function useUsageStats(
  range: UsageStatsRange,
  options: {
    dataSource?: "local" | "monitor";
    enabled?: boolean;
    preferredProviderId?: string;
    accountAccess?: LCodeProviderAccountAccess | LCodeAccountAccess;
    requirePreferredProvider?: boolean;
    allowEnvApiKey?: boolean;
  } = {},
) {
  const { usageStatsService } = useServices();
  const [state, setState] = useState<UsageStatsState>(INITIAL_STATE);
  const requestVersionRef = useRef(0);
  const dataSource = options.dataSource;
  const enabled = options.enabled ?? true;
  const preferredProviderId = options.preferredProviderId;
  const accountAccess = useStableAccountAccess(options.accountAccess);
  const requirePreferredProvider = options.requirePreferredProvider === true;
  const allowEnvApiKey = options.allowEnvApiKey;
  const requestScope = [
    dataSource ?? "",
    preferredProviderId ?? "",
    JSON.stringify(accountAccess ?? null),
    requirePreferredProvider ? "strict" : "relaxed",
    allowEnvApiKey === false ? "no-env" : "env",
  ].join("|");
  const lastRequestScopeRef = useRef(requestScope);

  const refresh = useCallback(async () => {
    if (!enabled) {
      return;
    }

    const requestVersion = requestVersionRef.current + 1;
    requestVersionRef.current = requestVersion;
    const keepPreviousSnapshot = lastRequestScopeRef.current === requestScope;
    lastRequestScopeRef.current = requestScope;
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    setState((current) => ({
      // 查询来源变化时清空旧快照，避免新请求期间或失败后显示另一来源的数据。
      snapshot: keepPreviousSnapshot ? current.snapshot : null,
      loading: true,
      error: null,
    }));

    try {
      const snapshot = await usageStatsService.getSnapshot({
        range,
        dataSource,
        preferredProviderId,
        accountAccess,
        requirePreferredProvider,
        allowEnvApiKey,
        timeZone,
      });
      if (requestVersionRef.current !== requestVersion) {
        return;
      }
      setState({
        snapshot,
        loading: false,
        error: null,
      });
    } catch (error) {
      if (requestVersionRef.current !== requestVersion) {
        return;
      }
      const message = getErrorMessage(error);
      logger.warn("[useUsageStats] 读取 usage 统计失败", {
        dataSource,
        range,
        preferredProviderId,
        timeZone,
        error: message,
      });
      setState((current) => ({
        snapshot: lastRequestScopeRef.current === requestScope ? current.snapshot : null,
        loading: false,
        error: message,
      }));
    }
  }, [
    accountAccess,
    allowEnvApiKey,
    dataSource,
    enabled,
    preferredProviderId,
    range,
    requestScope,
    requirePreferredProvider,
    usageStatsService,
  ]);

  useEffect(() => {
    if (!enabled) {
      setState({
        // 查询关闭时清空旧快照，避免继续显示上一账号的数据。
        snapshot: null,
        loading: false,
        error: null,
      });
      return;
    }

    void refresh();
  }, [enabled, refresh]);

  return {
    snapshot: state.snapshot,
    loading: state.loading,
    error: state.error,
    refresh,
  };
}

export function useAppUsageStats(range: AppUsageRange) {
  const { usageStatsService } = useServices();
  const [state, setState] = useState<AppUsageStatsState>({
    snapshot: null,
    loading: false,
    error: null,
  });
  const requestVersionRef = useRef(0);

  const refresh = useCallback(async () => {
    const requestVersion = requestVersionRef.current + 1;
    requestVersionRef.current = requestVersion;
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    setState((current) => ({
      snapshot: current.snapshot,
      loading: true,
      error: null,
    }));
    try {
      const snapshot = await usageStatsService.getAppUsageSnapshot({
        range,
        timeZone,
        connectionType: "api-key",
      });
      if (requestVersionRef.current !== requestVersion) {
        return;
      }
      setState({ snapshot, loading: false, error: null });
    } catch (error) {
      if (requestVersionRef.current !== requestVersion) {
        return;
      }
      const message = getErrorMessage(error);
      logger.warn("[useAppUsageStats] 读取本地使用统计失败", {
        range,
        timeZone,
        error: message,
      });
      setState((current) => ({
        snapshot: current.snapshot,
        loading: false,
        error: message,
      }));
    }
  }, [range, usageStatsService]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { ...state, refresh };
}
