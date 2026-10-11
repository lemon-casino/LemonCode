import { useCallback, useEffect, useRef, useState } from "react";
import {
  getGitBackupDestinationSelection,
  gitBackupWorkspaceKey,
  type GitBackupConfig,
  type GitBackupProvider,
  type GitBackupStatus,
  type GitBackupWorkspaceTarget,
  type IGitBackupService,
} from "@lcode/services";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import {
  clearLegacyGitBackupConfig,
  getGitBackupLegacyStorage,
  readLegacyGitBackupConfig,
} from "@/hooks/gitBackupLegacyConfig.js";
import {
  acceptGitBackupDraftSave,
  createGitBackupDraft,
  createGitBackupSavePatch,
  isGitBackupDraftDirty,
  validateGitBackupMinio,
  validateGitBackupOss,
  type GitBackupDraft,
} from "@/hooks/useGitBackupDraft.js";
import {
  canUseSavedGitBackupConfig,
  canUseSelectedGitBackupProviders,
  createGitBackupRequestScope,
  exportGitBackupPrivateKey,
  loadGitBackupSnapshot,
  projectGitBackupDestinationSelection,
  projectGitBackupDestinationClear,
  projectGitBackupConfigStatus,
  projectGitBackupEnabledStatus,
  canEnableGitBackup,
  updateGitBackupWorkspaceSelection,
  runGitBackup,
} from "@/hooks/useGitBackupActions.js";
import { collectGitBackupWorkspaces } from "@/hooks/gitBackupWorkspaceSelection.js";

const NO_WORKSPACE_CANDIDATES: readonly GitBackupWorkspaceTarget[] = [];

export interface GitBackupFeedback {
  id: string;
  detail?: string;
}
export type GitBackupOperation =
  | "save"
  | "toggle"
  | "test"
  | "backup"
  | "remove"
  | "selectWorkspace"
  | "clear"
  | "publicKey"
  | "export"
  | "refresh";
type TestResult = { ok: boolean; error?: string };
export function useGitBackup({
  service,
  target,
  connectionKind,
  workspaceCandidates = NO_WORKSPACE_CANDIDATES,
}: {
  service: IGitBackupService | null;
  target: GitBackupWorkspaceTarget | null;
  connectionKind: "local-ready" | "remote-ready" | "remote-waiting";
  workspaceCandidates?: readonly GitBackupWorkspaceTarget[];
}) {
  const platform = useOptionalPlatform();
  const [config, setConfig] = useState<GitBackupConfig | null>(null);
  const [status, setStatus] = useState<GitBackupStatus | null>(null);
  const [draft, setDraft] = useState<GitBackupDraft | null>(null);
  const [provider, setProvider] = useState<GitBackupProvider>("oss");
  const [loading, setLoading] = useState(Boolean(service));
  const [operation, setOperation] = useState<GitBackupOperation | null>(null);
  const [error, setError] = useState<GitBackupFeedback | null>(null);
  const [notice, setNotice] = useState<GitBackupFeedback | null>(null);
  const [testResults, setTestResults] = useState<
    Partial<Record<GitBackupProvider, TestResult | null>>
  >({});
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [legacyDraft, setLegacyDraft] = useState(false);
  const initialized = useRef(false);
  const lock = useRef(false);
  const scope = useRef(createGitBackupRequestScope());
  const draftRevision = useRef({ oss: 0, minio: 0 });
  const legacyStorage = useRef<ReturnType<typeof getGitBackupLegacyStorage>>(null);

  const readSnapshot = useCallback(
    async (isCurrent: () => boolean) => {
      if (!service) return;
      const next = await loadGitBackupSnapshot(service);
      if (!isCurrent()) return;
      setConfig(next.config);
      setStatus(next.status);
      if (!initialized.current) {
        initialized.current = true;
        const initial = createGitBackupDraft(next.config);
        // 浏览器旧凭据只作为本机未保存 OSS 草稿；不能复制到远端 Host 或触发自动启用。
        legacyStorage.current =
          connectionKind === "local-ready" ? getGitBackupLegacyStorage() : null;
        const legacy = !next.config.oss ? readLegacyGitBackupConfig(legacyStorage.current) : null;
        setDraft(legacy ? { ...initial, oss: legacy } : initial);
        setLegacyDraft(Boolean(legacy));
      }
    },
    [connectionKind, service],
  );

  const refresh = useCallback(async () => {
    if (!service || lock.current) return;
    lock.current = true;
    const isCurrent = scope.current.capture();
    setOperation("refresh");
    setError(null);
    setLoading(!initialized.current);
    try {
      await readSnapshot(isCurrent);
    } catch (cause) {
      if (isCurrent()) setError({ id: "settings.gitBackup.loadFailed", detail: message(cause) });
    } finally {
      if (isCurrent()) {
        lock.current = false;
        setOperation(null);
        setLoading(false);
      }
    }
  }, [readSnapshot, service]);

  useEffect(() => {
    const currentScope = createGitBackupRequestScope();
    scope.current = currentScope;
    lock.current = false;
    void refresh();
    return () => currentScope.dispose();
  }, [refresh]);

  const execute = async (
    kind: GitBackupOperation,
    action: (isCurrent: () => boolean) => Promise<void>,
  ) => {
    if (!service || lock.current || !config) return;
    lock.current = true;
    const isCurrent = scope.current.capture();
    setOperation(kind);
    setError(null);
    setNotice(null);
    try {
      await action(isCurrent);
    } catch (cause) {
      if (isCurrent()) setError({ id: `settings.gitBackup.${kind}Failed`, detail: message(cause) });
    } finally {
      if (isCurrent()) {
        lock.current = false;
        setOperation(null);
      }
    }
  };
  const refreshAfterWrite = async (isCurrent: () => boolean) => {
    try {
      await readSnapshot(isCurrent);
    } catch (cause) {
      if (isCurrent()) setError({ id: "settings.gitBackup.loadFailed", detail: message(cause) });
    }
  };

  const save = async () => {
    if (!draft || !config || !target) return;
    const savedProvider = provider;
    const validated = createGitBackupSavePatch(draft, config, savedProvider);
    if (validated.error) {
      setError(validated.error);
      return;
    }
    await execute("save", async (isCurrent) => {
      // 保存存储配置不能隐式恢复用户已取消的工作区，名单仅由勾选操作修改。
      await service!.configure(validated.config);
      if (!isCurrent()) return;
      const next: GitBackupConfig = {
        ...config,
        intervalMinutes: validated.config.intervalMinutes!,
        destinationEnabled: getGitBackupDestinationSelection(config),
        [savedProvider]: { ...validated.config[savedProvider], accessKeySecret: "" },
      };
      // 仅重置已保存目的地，另一方未确认草稿及旧浏览器 OSS 凭据必须保留。
      setConfig(next);
      setStatus((previous) => projectGitBackupConfigStatus(config, next, previous));
      setDraft((current) => current && acceptGitBackupDraftSave(current, next, savedProvider));
      setTestResults((current) => ({ ...current, [savedProvider]: null }));
      setNotice({ id: "settings.gitBackup.saved" });
      if (savedProvider === "oss") setLegacyDraft(false);
      try {
        await service!.markOnboardingComplete();
        if (!isCurrent()) return;
        if (savedProvider === "oss") clearLegacyGitBackupConfig(legacyStorage.current);
      } catch (cause) {
        if (isCurrent())
          setNotice({ id: "settings.gitBackup.migrationCleanupFailed", detail: message(cause) });
      }
      if (isCurrent()) await refreshAfterWrite(isCurrent);
    });
  };

  const setEnabled = async (enabled: boolean) => {
    if (!config || (enabled && !canEnableGitBackup(config, status))) return;
    await execute("toggle", async (isCurrent) => {
      await service!.configure({ enabled });
      if (!isCurrent()) return;
      setConfig({
        ...config,
        enabled,
      });
      setStatus((previous) => projectGitBackupEnabledStatus(previous, enabled));
      await refreshAfterWrite(isCurrent);
    });
  };

  const setDestinationEnabled = async (destination: GitBackupProvider, enabled: boolean) => {
    if (!config || (enabled && !canUseSavedGitBackupConfig(config, status, target, destination)))
      return;
    await execute("toggle", async (isCurrent) => {
      await service!.configure({ destinationEnabled: { [destination]: enabled } });
      if (!isCurrent()) return;
      const projected = projectGitBackupDestinationSelection(config, status, destination, enabled);
      setConfig({
        ...projected.config,
      });
      setStatus(projected.status);
      await refreshAfterWrite(isCurrent);
    });
  };

  const clearDestination = async () => {
    if (!config) return;
    const destination = provider;
    await execute("clear", async (isCurrent) => {
      await service!.configure({
        [destination]: null,
        destinationEnabled: { [destination]: false },
      });
      if (!isCurrent()) return;
      const projected = projectGitBackupDestinationClear(config, status, destination);
      const next = projected.config;
      setConfig(next);
      setStatus(projected.status);
      setDraft(
        (current) =>
          current && { ...current, [destination]: createGitBackupDraft(next)[destination] },
      );
      setTestResults((current) => ({ ...current, [destination]: null }));
      if (destination === "oss") setLegacyDraft(false);
      setNotice({ id: "settings.gitBackup.cleared" });
      await refreshAfterWrite(isCurrent);
    });
  };

  const testConnection = async () => {
    if (!draft || !config) return;
    const destination = provider;
    const validated =
      destination === "oss"
        ? validateGitBackupOss(draft.oss, config.oss)
        : validateGitBackupMinio(draft.minio, config.minio ?? null);
    if (validated.error) {
      setError(validated.error);
      return;
    }
    const revision = draftRevision.current[destination];
    setTestResults((current) => ({ ...current, [destination]: null }));
    await execute("test", async (isCurrent) => {
      let result: TestResult;
      try {
        result = await service!.testConnection(
          "oss" in validated ? validated.oss : validated.minio,
          destination,
        );
        if (!result.ok && !result.error) result = { ok: false, error: "Unknown connection error" };
      } catch (cause) {
        result = { ok: false, error: message(cause) };
      }
      // 类型切换不能把晚到结果显示在另一方，编辑过的草稿也不能接受旧测试结果。
      if (isCurrent() && revision === draftRevision.current[destination])
        setTestResults((current) => ({ ...current, [destination]: result }));
    });
  };

  const backup = async (destination: GitBackupProvider | "all" = provider) => {
    const ready =
      destination === "all"
        ? canUseSelectedGitBackupProviders(config, status, target)
        : canUseSavedGitBackupConfig(config, status, target, destination);
    if (!target || !status || status.running || !ready) return;
    await execute("backup", async (isCurrent) => {
      try {
        const result = await runGitBackup(
          service!,
          target,
          destination === "all" ? undefined : destination,
        );
        if (isCurrent())
          setNotice({
            id: "settings.gitBackup.backupCompleted",
            detail: String(result.totalFiles),
          });
      } finally {
        if (isCurrent()) await refreshAfterWrite(isCurrent);
      }
    });
  };
  const availableWorkspaces = collectGitBackupWorkspaces(
    workspaceCandidates,
    target,
    config?.workspaces ?? [],
  );
  const setWorkspaceSelected = async (workspace: GitBackupWorkspaceTarget, selected: boolean) => {
    if (
      !config ||
      !availableWorkspaces.some(
        (item) => gitBackupWorkspaceKey(item) === gitBackupWorkspaceKey(workspace),
      )
    )
      return;
    await execute(selected ? "selectWorkspace" : "remove", async (isCurrent) => {
      const projected = await updateGitBackupWorkspaceSelection(
        service!,
        config,
        status,
        workspace,
        selected,
      );
      if (!isCurrent()) return;
      setConfig(projected.config);
      setStatus(projected.status);
      await refreshAfterWrite(isCurrent);
    });
  };
  const viewPublicKey = async () =>
    execute("publicKey", async (isCurrent) => {
      const key = await service!.getPublicKey();
      if (isCurrent()) setPublicKey(key);
    });
  const exportPrivateKey = async () =>
    execute("export", async (isCurrent) => {
      const result = await exportGitBackupPrivateKey(service!, platform, isCurrent);
      if (isCurrent() && result !== "stale")
        setNotice({
          id:
            result === "canceled"
              ? "settings.gitBackup.exportCanceled"
              : platform?.canSelectFilePath
                ? "settings.gitBackup.exported"
                : "settings.gitBackup.downloadStarted",
        });
    });
  const updateDraft = (next: GitBackupDraft) => {
    draftRevision.current[provider]++;
    setDraft(next);
    setTestResults((current) => ({ ...current, [provider]: null }));
    setError(null);
    setNotice(null);
  };

  return {
    config,
    status,
    draft,
    provider,
    loading,
    operation,
    error,
    notice,
    testResult: testResults[provider] ?? null,
    publicKey,
    legacyDraft,
    unavailable: !service,
    dirty: Boolean(draft && config && isGitBackupDraftDirty(draft, config, provider)),
    canEnable: canEnableGitBackup(config, status),
    availableWorkspaces,
    canBackup:
      canUseSavedGitBackupConfig(config, status, target, provider) && status?.running === false,
    canBackupAll:
      canUseSelectedGitBackupProviders(config, status, target) && status?.running === false,
    canEnableDestination: (destination: GitBackupProvider) =>
      canUseSavedGitBackupConfig(config, status, target, destination),
    canExport: Boolean(platform?.saveFile),
    refresh,
    save,
    setEnabled,
    setDestinationEnabled,
    clearDestination,
    testConnection,
    backup,
    setWorkspaceSelected,
    viewPublicKey,
    exportPrivateKey,
    updateDraft,
    selectProvider: (next: GitBackupProvider) => {
      setProvider(next);
      setError(null);
      setNotice(null);
    },
    resetDraft: () => {
      if (config && draft) {
        updateDraft(acceptGitBackupDraftSave(draft, config, provider));
        if (provider === "oss") setLegacyDraft(false);
      }
    },
    closePublicKey: () => setPublicKey(null),
  };
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
