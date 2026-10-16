import { useCallback, useEffect, useRef, useState } from "react";
import type { IProviderAccountService } from "@lcode/services";
import type {
  ProviderAccountView,
  ProviderAuthorization,
  StartProviderAuthorization,
} from "@lcode/shared";
import { useServices } from "@/hooks/useServices.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { logger } from "@/logger.js";
import { getProviderAccountDependencyError } from "@/lib/providerAccountErrors.js";

interface AccountScope {
  service: IProviderAccountService | undefined;
  active: boolean;
  authorizationGeneration: number;
  attempt: ProviderAuthorization | null;
}

/** 只投影 Host 的安全账号视图。离开当前 Environment 后所有异步响应都失效。 */
export function useProviderAccounts() {
  const { providerAccountService: service } = useServices();
  const platform = usePlatform();
  const scopeRef = useRef<AccountScope | null>(null);
  const [owned, setOwned] = useState<{ service: typeof service; view: ProviderAccountView | null }>(
    { service, view: null },
  );
  const [authorization, setAuthorization] = useState<ProviderAuthorization | null>(null);
  const [loading, setLoading] = useState(Boolean(service));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<
    "load" | "action" | "claudeCliRequired" | "grokCliRequired" | null
  >(null);
  const [pollVersion, setPollVersion] = useState(0);
  const isCurrent = useCallback(
    (scope: AccountScope) => scope.active && scopeRef.current === scope,
    [],
  );
  const commit = useCallback(
    (scope: AccountScope, view: ProviderAccountView) => {
      if (!isCurrent(scope)) return;
      setOwned((current) =>
        current.service === scope.service && current.view && current.view.revision > view.revision
          ? current
          : { service: scope.service, view },
      );
    },
    [isCurrent],
  );
  const refresh = useCallback(async () => {
    const scope = scopeRef.current;
    if (!scope?.service || !isCurrent(scope)) return;
    setLoading(true);
    setError(null);
    setPollVersion((version) => version + 1);
    try {
      commit(scope, await scope.service.getView());
    } catch {
      if (isCurrent(scope)) setError("load");
    } finally {
      if (isCurrent(scope)) setLoading(false);
    }
  }, [commit, isCurrent]);

  useEffect(() => {
    const scope: AccountScope = {
      service,
      active: true,
      authorizationGeneration: 0,
      attempt: null,
    };
    scopeRef.current = scope;
    setAuthorization(null);
    setBusy(null);
    setError(null);
    const subscription = service?.onDidChange((view) => commit(scope, view));
    void refresh();
    return () => {
      // 切分类/关页/换 Environment 必须取消旧 attempt，不能让迟到授权创建意外账号。
      scope.active = false;
      scope.authorizationGeneration++;
      subscription?.dispose();
      if (scope.attempt?.status === "pending") {
        void service?.cancelAuthorization(scope.attempt.attemptId).catch(() => {
          logger.warn("[ProviderAccounts] 取消离开页面的授权失败");
        });
      }
    };
  }, [commit, refresh, service]);

  const acceptAuthorization = useCallback(
    (scope: AccountScope, next: ProviderAuthorization) => {
      if (!isCurrent(scope)) return;
      // 手动提交完成与旧轮询可交错返回；同一 attempt 的终态不能被迟到 pending 回退。
      const previous = scope.attempt;
      if (
        previous?.attemptId === next.attemptId &&
        previous.status !== "pending" &&
        !(
          previous.status === "completed" &&
          previous.diagnostic?.followupPending &&
          next.status === "completed"
        )
      )
        return;
      scope.attempt = next;
      setAuthorization(next);
      if (
        next.status === "completed" &&
        (previous?.status !== "completed" || !next.diagnostic?.followupPending)
      )
        void refresh();
    },
    [isCurrent, refresh],
  );

  useEffect(() => {
    if (
      authorization?.status !== "pending" &&
      !(authorization?.status === "completed" && authorization.diagnostic?.followupPending)
    )
      return;
    const scope = scopeRef.current;
    if (!scope?.service) return;
    const generation = scope.authorizationGeneration;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await scope.service!.getAuthorization(authorization.attemptId);
        if (!cancelled && isCurrent(scope) && generation === scope.authorizationGeneration) {
          acceptAuthorization(scope, next);
          if (
            next.status === "pending" ||
            (next.status === "completed" && next.diagnostic?.followupPending)
          )
            timer = setTimeout(poll, 1000);
        }
      } catch {
        if (!cancelled && isCurrent(scope)) setError("action");
      }
    };
    timer = setTimeout(poll, 1000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    acceptAuthorization,
    authorization?.attemptId,
    authorization?.status,
    authorization?.diagnostic?.followupPending,
    isCurrent,
    pollVersion,
  ]);

  const openBrowser = useCallback(
    (url: string | undefined) => {
      if (!url) return;
      // 只打开授权驱动提供的 HTTP(S) 页面，不允许自定义协议变成任意命令入口。
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
          throw new Error("invalid_authorization_url");
        platform.openExternal(parsed.href);
      } catch {
        setError("action");
      }
    },
    [platform],
  );

  const start = useCallback(
    async (input: StartProviderAuthorization) => {
      const scope = scopeRef.current;
      // 文件读取可能跨 Environment 完成；旧表单捕获的提交函数不能向新的 Host 发送凭据。
      if (!scope?.service || scope.service !== service || !isCurrent(scope)) return;
      const generation = ++scope.authorizationGeneration;
      setBusy("authorize");
      setError(null);
      try {
        if (scope.attempt?.status === "pending")
          await scope.service.cancelAuthorization(scope.attempt.attemptId);
        if (!isCurrent(scope) || generation !== scope.authorizationGeneration) return;
        const next = await scope.service.startAuthorization(input);
        if (!isCurrent(scope) || generation !== scope.authorizationGeneration) {
          await scope.service.cancelAuthorization(next.attemptId);
          return;
        }
        acceptAuthorization(scope, next);
        if (next.status === "pending") openBrowser(next.url);
      } catch (cause) {
        if (isCurrent(scope) && generation === scope.authorizationGeneration)
          setError(getProviderAccountDependencyError(cause) ?? "action");
      } finally {
        if (isCurrent(scope) && generation === scope.authorizationGeneration) setBusy(null);
      }
    },
    [acceptAuthorization, isCurrent, openBrowser, service],
  );

  const cancel = useCallback(async () => {
    const scope = scopeRef.current;
    if (!scope?.service || !isCurrent(scope)) return false;
    const attempt = scope.attempt;
    const generation = ++scope.authorizationGeneration;
    if (!attempt || attempt.status !== "pending") {
      scope.attempt = null;
      setAuthorization(null);
      setBusy(null);
      return true;
    }
    setBusy("cancel");
    setError(null);
    try {
      const next = await scope.service.cancelAuthorization(attempt.attemptId);
      if (!isCurrent(scope) || generation !== scope.authorizationGeneration) return false;
      acceptAuthorization(scope, next);
      return next.status !== "pending";
    } catch {
      // 取消 RPC 失败不等于 Host 已取消；保留 attempt 让用户重试，并在离开页面时再次取消。
      if (isCurrent(scope) && generation === scope.authorizationGeneration) setError("action");
      return false;
    } finally {
      if (isCurrent(scope) && generation === scope.authorizationGeneration) {
        setBusy(null);
        setPollVersion((version) => version + 1);
      }
    }
  }, [acceptAuthorization, isCurrent]);

  const complete = useCallback(
    async (code: string) => {
      const scope = scopeRef.current;
      if (!scope?.service || !scope.attempt || scope.attempt.status !== "pending") return;
      const generation = scope.authorizationGeneration;
      setBusy("complete");
      setError(null);
      try {
        const next = await scope.service.completeAuthorization(scope.attempt.attemptId, code);
        if (isCurrent(scope) && generation === scope.authorizationGeneration)
          acceptAuthorization(scope, next);
      } catch (cause) {
        if (isCurrent(scope) && generation === scope.authorizationGeneration)
          setError(getProviderAccountDependencyError(cause) ?? "action");
      } finally {
        if (isCurrent(scope) && generation === scope.authorizationGeneration) setBusy(null);
      }
    },
    [acceptAuthorization, isCurrent],
  );

  const mutate = useCallback(
    async (
      connectionId: string,
      action: (
        target: IProviderAccountService,
        current: () => boolean,
      ) => Promise<ProviderAccountView>,
    ) => {
      const scope = scopeRef.current;
      if (!scope?.service || !isCurrent(scope)) return;
      setBusy(connectionId);
      setError(null);
      try {
        const next = await action(scope.service, () => isCurrent(scope));
        if (!isCurrent(scope)) return;
        commit(scope, next);
        return next;
      } catch (cause) {
        if (isCurrent(scope)) setError(getProviderAccountDependencyError(cause) ?? "action");
      } finally {
        if (isCurrent(scope)) setBusy(null);
      }
    },
    [commit, isCurrent],
  );
  return {
    available: Boolean(service),
    view: owned.service === service ? owned.view : null,
    authorization,
    loading,
    busy,
    error,
    refresh,
    start,
    cancel,
    complete,
    openBrowser,
    refreshModels: (id: string) => mutate(id, (target) => target.refreshModels(id)),
    removeAccount: (id: string) => mutate(id, (target) => target.removeAccount(id)),
    checkinAccount: (id: string) => mutate(id, (target) => target.checkinAccount(id)),
    checkinAll: (channelId?: string) =>
      mutate("checkin-all", (target) => target.checkinAll(channelId)),
    setAutomaticCheckin: (id: string, enabled: boolean) =>
      mutate(id, (target) => target.setAutomaticCheckin(id, enabled)),
    setChannelAutomaticCheckin: (channelId: string, enabled: boolean) =>
      mutate("checkin-auto", async (target, current) => {
        let next = await target.getView();
        for (const account of next.accounts.filter((item) => item.channelId === channelId)) {
          // 切换 Environment 后停止批量写入旧 Host，不能仅丢弃最后一次 UI 响应。
          if (!current()) break;
          next = await target.setAutomaticCheckin(account.connectionId, enabled);
        }
        return next;
      }),
    setAccountEnabled: (id: string, enabled: boolean) =>
      mutate(id, (target) => target.setAccountEnabled(id, enabled)),
  };
}
