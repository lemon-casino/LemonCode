import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IServiceAccessor } from "@lcode/services";
import {
  WINDOW_WORKSPACE_RECONNECT_UNAVAILABLE,
  WINDOW_WORKSPACE_RECONNECT_TARGET_UNAVAILABLE,
  type WindowWorkspaceReconnectResult,
} from "@lcode/shared";
import type { TabStore } from "@/store/tabStore.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { toast } from "@/components/ui/toast.js";
import { logger } from "@/logger.js";
import {
  executeDesktopWorkspaceReconnect,
  resolveWindowWorkspaceReconnectTarget,
  type DesktopWorkspaceReconnect,
} from "./windowWorkspaceReconnect.js";

export function useWindowWorkspaceReconnect({
  services,
  tabs,
  isDesktop,
  browserScope,
  desktopReconnect,
}: {
  services: IServiceAccessor;
  tabs: TabStore;
  isDesktop: boolean;
  browserScope?: string;
  desktopReconnect: DesktopWorkspaceReconnect;
}) {
  const { intl } = useLCodeIntl();
  const owner = services.windowWorkspaceService;
  const stamp = useMemo(() => ({}), [owner, browserScope]);
  const current = useRef<object | null>(stamp);
  current.current = stamp;
  const latestDesktopReconnect = useRef(desktopReconnect);
  latestDesktopReconnect.current = desktopReconnect;
  const desktopFlights = useMemo(() => new Map<string, Promise<void>>(), [stamp]);
  const browserFlights = useMemo(() => new Map<string, Promise<void>>(), [stamp]);
  const [view, setView] = useState({
    stamp,
    pendingKeys: [] as string[],
    errors: {} as Record<string, string>,
  });
  const executeDesktop = useCallback<DesktopWorkspaceReconnect>(
    (key, options) => {
      const existing = desktopFlights.get(key);
      if (existing) return existing;
      // 共用的执行 Promise 保留失败，远控加入桌面已发起的重连时也必须收到真实结果。
      const operation = Promise.resolve().then(() =>
        latestDesktopReconnect.current(key, { ...options, throwOnFailure: true }),
      );
      desktopFlights.set(key, operation);
      void operation.finally(() => desktopFlights.delete(key)).catch(() => {});
      return operation;
    },
    [desktopFlights],
  );

  useEffect(() => {
    current.current = stamp;
    return () => {
      if (current.current === stamp) current.current = null;
    };
  }, [stamp]);

  useEffect(() => {
    if (!isDesktop || !owner) return;
    const subscription = owner.onDynamicReconnectRequested()((request) => {
      void (async () => {
        let result: WindowWorkspaceReconnectResult;
        try {
          await executeDesktopWorkspaceReconnect(request, tabs, executeDesktop);
          result = { requestId: request.requestId, ok: true };
        } catch (error) {
          result = { requestId: request.requestId, ok: false, error: getErrorMessage(error) };
        }
        try {
          await owner.completeReconnect(result);
        } catch (error) {
          logger.warn("[workspace-reconnect] 完成结果未送达", { error });
        }
      })();
    });
    return () => subscription.dispose();
  }, [isDesktop, owner, tabs, executeDesktop]);

  const reconnect = useCallback<DesktopWorkspaceReconnect>(
    (key, options) => {
      if (!browserScope)
        return executeDesktop(key, options).catch((error) => {
          // 本地按钮继续由既有流程展示错误；只有显式要求结果的调用方继续接收 rejection。
          if (options?.throwOnFailure) throw error;
        });
      const existing = browserFlights.get(key);
      if (existing) return existing;
      // 原因：远控之前调用禁止 Web 建连的桌面入口并丢弃 rejection，点击看起来完全无效。
      // 这里只提交已有 identity，让 Desktop owner 使用原流程重连；失败必须进入可重试的 UI 投影。
      const operation = Promise.resolve().then(async () => {
        const update = (fn: (state: typeof view) => typeof view) => {
          if (current.current !== stamp) return;
          setView((previous) =>
            fn(previous.stamp === stamp ? previous : { stamp, pendingKeys: [], errors: {} }),
          );
        };
        update((state) => ({
          ...state,
          pendingKeys: [...state.pendingKeys, key],
          errors: { ...state.errors, [key]: "" },
        }));
        try {
          const target = resolveWindowWorkspaceReconnectTarget(tabs, key);
          if (!owner) throw new Error(WINDOW_WORKSPACE_RECONNECT_UNAVAILABLE);
          await owner.requestReconnect(target);
        } catch (error) {
          const rawMessage = getErrorMessage(error);
          const message =
            rawMessage === WINDOW_WORKSPACE_RECONNECT_UNAVAILABLE
              ? intl.formatMessage({ id: "workspaceSidebar.reconnectDesktopUnavailable" })
              : rawMessage === WINDOW_WORKSPACE_RECONNECT_TARGET_UNAVAILABLE
                ? intl.formatMessage({ id: "workspaceSidebar.reconnectTargetUnavailable" })
                : rawMessage;
          update((state) => ({ ...state, errors: { ...state.errors, [key]: message } }));
          if (current.current === stamp)
            toast(message, { variant: "warning", dedupeKey: `workspace-reconnect:${key}` });
        } finally {
          browserFlights.delete(key);
          update((state) => ({
            ...state,
            pendingKeys: state.pendingKeys.filter((value) => value !== key),
          }));
        }
      });
      browserFlights.set(key, operation);
      return operation;
    },
    [browserScope, browserFlights, executeDesktop, stamp, tabs, owner, intl],
  );
  return {
    reconnect,
    pendingKeys: view.stamp === stamp ? view.pendingKeys : [],
    errors: view.stamp === stamp ? view.errors : {},
  };
}
