import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { ProviderApiKey } from "@lcode/provider";
import type { ProviderApiKeyProbeResult } from "@lcode/services";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import type { ProviderApiKeyProbeRunOptions } from "@/hooks/providerApiKeyProbe.js";
import { createProviderApiKeyOperationGuard } from "./providerApiKeys.js";
import { createProviderApiKeyId, ProviderApiKeyImportError } from "./providerApiKeyImport.js";
import { API_KEY_PAGE_SIZE, getProviderApiKeyPage } from "./providerApiKeyList.js";
import { runProviderApiKeyWorker, yieldToBrowser } from "./providerApiKeyImportWorkerClient.js";

export type ProviderApiKeyProbeState = ProviderApiKeyProbeResult["status"] | "pending";
export interface ProviderApiKeyManagerProps {
  open: boolean;
  scopeKey: string;
  apiKeys: readonly ProviderApiKey[];
  onOpenChange: (open: boolean) => void;
  onSave: (apiKeys: readonly ProviderApiKey[]) => Promise<void>;
  onProbe: (
    keyIds: readonly string[],
    options?: ProviderApiKeyProbeRunOptions,
  ) => Promise<readonly ProviderApiKeyProbeResult[]>;
}

export function useProviderApiKeyManager({
  open,
  scopeKey,
  apiKeys,
  onOpenChange,
  onSave,
  onProbe,
}: ProviderApiKeyManagerProps) {
  const { intl } = useLCodeIntl();
  const [draft, setDraft] = useState<ProviderApiKey[]>(() => (open ? [...apiKeys] : []));
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState<"save" | "probe" | "import" | "cleanup" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importSummary, setImportSummary] = useState<{ added: number; duplicates: number } | null>(
    null,
  );
  const [requestedPage, setPage] = useState(1);
  const probeStates = useRef(new Map<string, ProviderApiKeyProbeState>());
  const [probeProgress, setProbeProgress] = useState<{
    total: number;
    completed: number;
    valid: number;
    invalid: number;
    failed: number;
    phase: "preparing" | "running" | "stopping" | "finishing" | "complete" | "stopped";
  } | null>(null);
  const [invalidIds, setInvalidIds] = useState<ReadonlySet<string>>(new Set());
  const apiKeysRef = useRef(apiKeys);
  apiKeysRef.current = apiKeys;
  const activeWorker = useRef<AbortController | null>(null);
  const guardRef = useRef<ReturnType<typeof createProviderApiKeyOperationGuard> | null>(null);
  if (guardRef.current === null) guardRef.current = createProviderApiKeyOperationGuard(null);
  const guard = guardRef.current;

  useLayoutEffect(() => {
    guard.setScope(open ? scopeKey : null);
    setDraft(open ? [...apiKeysRef.current] : []);
    setImportOpen(false);
    setImportSummary(null);
    setError(null);
    setVisible(false);
    setPage(1);
    setBusy(null);
    probeStates.current = new Map();
    setProbeProgress(null);
    setInvalidIds(new Set());
    return () => {
      // 关闭/切换供应商同时取消后台计算与代次；旧操作不能把十万条结果提交到新草稿。
      activeWorker.current?.abort();
      guard.invalidate();
    };
  }, [open, scopeKey, guard]);

  const page = getProviderApiKeyPage(draft.length, requestedPage);
  const canClose = busy !== "save";
  const begin = (kind: NonNullable<typeof busy>) => {
    const operation = guard.begin();
    activeWorker.current?.abort();
    const controller = new AbortController();
    activeWorker.current = controller;
    setBusy(kind);
    setError(null);
    return { operation, signal: controller.signal };
  };
  const importFailure = (failure: unknown) => {
    const code = failure instanceof ProviderApiKeyImportError ? failure.code : "workerFailed";
    setError(
      intl.formatMessage({ id: `settings.modelProvider.apiKeyManager.import.error.${code}` }),
    );
  };

  const importKeys = async (source: string | File[] | { clipboard: true }) => {
    if (busy !== null) return false;
    const { operation, signal } = begin("import");
    setImportOpen(true);
    setImportSummary(null);
    try {
      let content: string | File[];
      if (typeof source !== "string" && !Array.isArray(source)) {
        try {
          content = await navigator.clipboard.readText();
        } catch {
          if (guard.isCurrent(operation))
            setError(
              intl.formatMessage({
                id: "settings.modelProvider.apiKeyManager.import.error.clipboardFailed",
              }),
            );
          return false;
        }
      } else content = source;
      if (!guard.isCurrent(operation)) return false;
      const result = await runProviderApiKeyWorker(
        draft,
        { kind: "import", source: content },
        signal,
      );
      if (!guard.isCurrent(operation)) return false;
      setDraft(draft.concat(result.keys));
      if (result.added > 0) setPage(Math.floor(draft.length / API_KEY_PAGE_SIZE) + 1);
      setImportSummary({ added: result.added, duplicates: result.duplicates });
      return true;
    } catch (failure) {
      if (guard.isCurrent(operation)) importFailure(failure);
      return false;
    } finally {
      if (guard.isCurrent(operation)) setBusy(null);
    }
  };

  const clearProbeForKey = useCallback(
    (id: string) => {
      probeStates.current.delete(id);
      if (invalidIds.has(id))
        setInvalidIds((current) => {
          const next = new Set(current);
          next.delete(id);
          return next;
        });
    },
    [invalidIds],
  );
  const updateKey = useCallback(
    (index: number, patch: Partial<ProviderApiKey>) => {
      const key = draft[index];
      if (!key || busy !== null) return;
      // 只复制数组并替换定位到的单行，不再在每次输入时全量规范化/渲染十万个 Key。
      const next = [...draft];
      next[index] = { ...key, ...patch };
      setDraft(next);
      if (patch.apiKey !== undefined && patch.apiKey !== key.apiKey) clearProbeForKey(key.id);
    },
    [draft, busy, clearProbeForKey],
  );
  const addKey = () => {
    setDraft([
      ...draft,
      {
        id: createProviderApiKeyId(),
        label: `API Key ${draft.length + 1}`,
        apiKey: "",
        enabled: true,
      },
    ]);
    setPage(getProviderApiKeyPage(draft.length + 1, Number.MAX_SAFE_INTEGER).page);
  };
  const removeKey = useCallback(
    (index: number) => {
      const key = draft[index];
      if (!key) return;
      setDraft(draft.slice(0, index).concat(draft.slice(index + 1)));
      clearProbeForKey(key.id);
    },
    [draft, clearProbeForKey],
  );
  const removeAll = () => {
    setDraft([]);
    probeStates.current = new Map();
    setProbeProgress(null);
    setInvalidIds(new Set());
    setImportSummary(null);
    setPage(1);
  };
  const removeInvalid = async () => {
    if (busy !== null || invalidIds.size === 0) return;
    const { operation, signal } = begin("cleanup");
    try {
      const result = await runProviderApiKeyWorker(
        draft,
        { kind: "removeInvalid", invalidIds: [...invalidIds] },
        signal,
      );
      if (!guard.isCurrent(operation)) return;
      setDraft(result.keys);
      setInvalidIds(new Set());
      setImportSummary(null);
    } catch (failure) {
      if (guard.isCurrent(operation)) importFailure(failure);
    } finally {
      if (guard.isCurrent(operation)) setBusy(null);
    }
  };

  const save = async () => {
    const { operation, signal } = begin("save");
    try {
      const result = await runProviderApiKeyWorker(draft, { kind: "normalize" }, signal);
      if (!guard.isCurrent(operation)) return;
      await onSave(result.keys);
      if (guard.isCurrent(operation)) onOpenChange(false);
    } catch (failure) {
      if (!guard.isCurrent(operation)) return;
      if (failure instanceof ProviderApiKeyImportError) importFailure(failure);
      else setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (guard.isCurrent(operation)) setBusy(null);
    }
  };
  const probe = async () => {
    if (busy !== null) return;
    const { operation, signal } = begin("probe");
    probeStates.current = new Map();
    setInvalidIds(new Set());
    const invalid = new Set<string>();
    const counts = { completed: 0, valid: 0, invalid: 0, failed: 0 };
    let total = draft.length;
    const admitResults = (results: readonly ProviderApiKeyProbeResult[]) => {
      if (!guard.isCurrent(operation)) return;
      for (const result of results) {
        if (probeStates.current.has(result.keyId)) continue;
        probeStates.current.set(result.keyId, result.status);
        counts.completed++;
        if (result.status === "invalid") {
          invalid.add(result.keyId);
          counts.invalid++;
        } else if (result.status === "valid") counts.valid++;
        else counts.failed++;
      }
      // 只发布计数；结果 Map 增量写入，不在每批响应时复制十万项状态。
      setProbeProgress({ total, ...counts, phase: signal.aborted ? "stopping" : "running" });
    };
    setProbeProgress({ total, ...counts, phase: "preparing" });
    try {
      const { keys } = await runProviderApiKeyWorker(draft, { kind: "normalize" }, signal);
      if (!guard.isCurrent(operation)) return;
      if (keys.length === 0) {
        setError(intl.formatMessage({ id: "settings.modelProvider.apiKeyManager.empty" }));
        return;
      }
      total = keys.length;
      // 检测读取服务已接受的配置，继续复用先保存再检测的唯一写入路径。
      await onSave(keys);
      if (!guard.isCurrent(operation)) return;
      if (signal.aborted) return;
      const results = await onProbe([], {
        operationId: createProviderApiKeyId(),
        signal,
        onProgress: (progress) => {
          total = progress.total;
          admitResults(progress.results);
        },
      });
      if (!guard.isCurrent(operation)) return;
      for (let index = 0; index < results.length; index += 2_000) {
        admitResults(results.slice(index, index + 2_000));
        await yieldToBrowser();
        if (!guard.isCurrent(operation)) return;
      }
      let next = keys;
      setInvalidIds(invalid);
      setProbeProgress({ total, ...counts, phase: "finishing" });
      if (invalid.size > 0) {
        const finalizer = new AbortController();
        activeWorker.current = finalizer;
        next = (
          await runProviderApiKeyWorker(
            keys,
            { kind: "disableInvalid", invalidIds: [...invalid] },
            finalizer.signal,
          )
        ).keys;
        if (!guard.isCurrent(operation)) return;
        setDraft(next);
        await onSave(next);
        if (!guard.isCurrent(operation)) return;
      }
      setDraft(next);
      setInvalidIds(invalid);
      setProbeProgress({ total, ...counts, phase: signal.aborted ? "stopped" : "complete" });
    } catch (failure) {
      if (!guard.isCurrent(operation)) return;
      if (signal.aborted) {
        setProbeProgress({ total, ...counts, phase: "stopped" });
        return;
      }
      if (failure instanceof ProviderApiKeyImportError) importFailure(failure);
      else setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (guard.isCurrent(operation)) {
        if (signal.aborted) setProbeProgress({ total, ...counts, phase: "stopped" });
        setBusy(null);
      }
    }
  };
  const stopProbe = () => {
    if (busy !== "probe") return;
    setProbeProgress((current) => (current ? { ...current, phase: "stopping" } : null));
    activeWorker.current?.abort();
  };
  const getProbeState = (id: string) =>
    probeStates.current.get(id) ?? (busy === "probe" ? "pending" : undefined);

  return {
    draft,
    visible,
    setVisible,
    busy,
    error,
    importOpen,
    setImportOpen,
    importSummary,
    page,
    setPage,
    canClose,
    importKeys,
    updateKey,
    addKey,
    removeKey,
    removeAll,
    removeInvalid,
    invalidCount: invalidIds.size,
    save,
    probe,
    stopProbe,
    probeProgress,
    getProbeState,
  };
}
