import { useCallback, useEffect, useState, type ComponentType } from "react";
import {
  buildRemoteWorkspaceIdentity,
  type AppSettings,
  type RemoteTarget,
  type IPlatformService,
} from "@lcode/shared";
import type { IServiceAccessor } from "@lcode/services";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useRemoteWorkspaceHistory } from "@/root/useRemoteWorkspaceHistory.js";
import { useTabStoreApi } from "@/store/TabStoreProvider.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";

/** 网络和磁盘桩只提供 IO，历史状态、提交顺序、失败恢复均执行真实 Root owner。 */
export function createHistoryRemovalFixture({
  enabled,
  settings,
  origin,
  target,
  defaults,
  calls,
  facts,
}: {
  enabled: boolean;
  settings: Partial<AppSettings>;
  origin: string;
  target: Extract<RemoteTarget, { kind: "ssh" }>;
  defaults: IServiceAccessor;
  calls: Array<{ method: string; params: unknown }>;
  facts: { connects: number; finishedReconnects: number };
}) {
  let rejectSave = false;
  let finishConnection: (() => void) | undefined;
  let finishCancellation: (() => void) | undefined;
  const listeners = new Set<() => void>();
  if (enabled && !settings.lastWorkspaceSession) {
    const targets = [target, { ...target, host: "other.invalid" }];
    settings.lastWorkspaceSession = [
      { kind: "local", workspacePath: origin },
      ...targets.map((remoteTarget) => ({
        kind: "remote" as const,
        workspacePath: origin,
        target: remoteTarget,
        lastOpenedAt: 1,
        lastConnectionStatus: "failed" as const,
      })),
    ];
    settings.projectDefinitions = {
      version: 1,
      projects: [
        ...(settings.localProjects ?? []),
        ...targets.map((remoteTarget, index) => ({
          id: `saved-${index}`,
          name: index ? "另一台远程项目" : "保存的远程项目",
          primaryFolderPath: origin,
          sourceFolderPaths: [origin],
          workspaceIdentity: buildRemoteWorkspaceIdentity(origin, remoteTarget),
        })),
      ],
    };
  }
  return {
    reconnect: (onReconnect?: (key: string) => Promise<void>) => async (key: string) => {
      if (!onReconnect) {
        facts.connects++;
        return;
      }
      try {
        await onReconnect(key);
      } finally {
        facts.finishedReconnects++;
      }
    },
    update: async (patch: Partial<AppSettings>) => {
      if (!enabled) return defaults.settingService.update(patch);
      calls.push({ method: "saveHistory", params: patch });
      if (rejectSave) throw new Error("Fixture history save failed");
      Object.assign(settings, patch);
      localStorage.setItem("sidebar-fixture-projects", JSON.stringify(settings));
    },
    services: enabled
      ? {
          credentialService: {
            ...defaults.credentialService,
            load: async () => null,
            delete: async (key: string) => {
              calls.push({ method: "deleteCredential", params: key });
            },
          },
        }
      : {},
    platform: {
      onSettingsChanged: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      ...(enabled
        ? {
            connectRemote: async () => {
              facts.connects++;
              return new Promise<{ success: false; error: string }>((resolve) => {
                finishConnection = () =>
                  resolve({ success: false, error: "Fixture late connection failure" });
              });
            },
            cancelPendingRemoteConnection: async () =>
              new Promise<void>((resolve) => {
                finishCancellation = resolve;
              }),
          }
        : {}),
    } satisfies Partial<IPlatformService>,
    notifySettingsChanged: () => {
      listeners.forEach((listener) => listener());
    },
    actions: {
      rejectHistorySave: (reject: boolean) => {
        rejectSave = reject;
      },
      finishConnection: () => finishConnection?.(),
      finishCancellation: () => finishCancellation?.(),
    },
    tabs: (tabs: WorkspaceTabState[], opened: boolean) =>
      !enabled
        ? tabs
        : tabs
            .filter(
              (tab) =>
                !tab.remoteTarget ||
                (opened &&
                  settings.lastWorkspaceSession?.some(
                    (entry) =>
                      entry.kind === "remote" &&
                      entry.target.kind === "ssh" &&
                      entry.target.host === target.host,
                  )),
            )
            .map((tab) => ({ ...tab, remoteSessionId: undefined })),
  };
}

export interface HistoryRemovalActions {
  onRemoveRemoteProject?: (key: string) => Promise<void>;
  onReconnect?: (key: string) => Promise<void>;
}
export function SavedHistoryFixture({
  services,
  content: Content,
}: {
  services: IServiceAccessor;
  content: ComponentType<HistoryRemovalActions>;
}) {
  const api = useTabStoreApi();
  const { intl } = useLCodeIntl();
  const platform = usePlatform();
  const [restored, setRestored] = useState(false);
  const activateTabByPath = useCallback(
    (...args: Parameters<ReturnType<typeof api.getState>["activateTabByPath"]>) =>
      api.getState().activateTabByPath(...args),
    [api],
  );
  const addTab = useCallback(
    (...args: Parameters<ReturnType<typeof api.getState>["addTab"]>) => {
      api.getState().addTab(...args);
    },
    [api],
  );
  const { restorePersistedSession, handleRemoveRemoteProject, handleReconnectRemoteWorkspace } =
    useRemoteWorkspaceHistory({
      intl,
      services,
      platform,
      supportsSettings: true,
      tabStoreApi: api,
      activateTabByPath,
      addTab,
    });
  useEffect(() => {
    let cancelled = false;
    void services.settingService.get().then(async (current) => {
      if (cancelled) return;
      await restorePersistedSession(current);
      if (!cancelled) setRestored(true);
    });
    return () => {
      cancelled = true;
    };
  }, [restorePersistedSession, services]);
  return restored ? (
    <Content
      onRemoveRemoteProject={handleRemoveRemoteProject}
      onReconnect={handleReconnectRemoteWorkspace}
    />
  ) : null;
}
