import { useLayoutEffect, useRef, useState } from "react";
import type { ProviderApiKey } from "@lcode/provider";
import type { ProviderApiKeyProbeResult } from "@lcode/services";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
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
  onProbe: (keyIds: readonly string[]) => Promise<readonly ProviderApiKeyProbeResult[]>;
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
  const [draft, setDraft] = useState<ProviderApiKey[]>(() => [...apiKeys]);
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState<"save" | "probe" | "import" | "cleanup" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importSummary, setImportSummary] = useState<{ added: number; duplicates: number } | null>(
    null,
  );
  const [requestedPage, setPage] = useState(1);
  const [probeStates, setProbeStates] = useState<Record<string, ProviderApiKeyProbeState>>({});
  const [ignoredProbeIds, setIgnoredProbeIds] = useState<ReadonlySet<string>>(new Set());
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
    setProbeStates({});
    setIgnoredProbeIds(new Set());
    setInvalidIds(new Set());
    return () => {
      // 关闭/切换供应商同时取消后台计算与代次；旧操作不能把十万条结果提交到新草稿。
      activeWorker.current?.abort();
      guard.invalidate();
    };
  }, [open, scopeKey, guard]);

  const page = getProviderApiKeyPage(draft.length, requestedPage);
  const canClose = busy === null || busy === "import" || busy === "cleanup";
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

  const clearProbeForKey = (id: string) => {
    setIgnoredProbeIds((current) => new Set(current).add(id));
    if (invalidIds.has(id))
      setInvalidIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
  };
  const updateKey = (index: number, patch: Partial<ProviderApiKey>) => {
    const key = draft[index];
    if (!key || busy !== null) return;
    // 只复制数组并替换定位到的单行，不再在每次输入时全量规范化/渲染十万个 Key。
    const next = [...draft];
    next[index] = { ...key, ...patch };
    setDraft(next);
    if (patch.apiKey !== undefined && patch.apiKey !== key.apiKey) clearProbeForKey(key.id);
  };
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
  const removeKey = (index: number) => {
    const key = draft[index];
    if (!key) return;
    setDraft(draft.slice(0, index).concat(draft.slice(index + 1)));
    clearProbeForKey(key.id);
  };
  const removeAll = () => {
    setDraft([]);
    setProbeStates({});
    setIgnoredProbeIds(new Set());
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
    const { operation, signal } = begin("probe");
    try {
      const { keys } = await runProviderApiKeyWorker(draft, { kind: "normalize" }, signal);
      if (!guard.isCurrent(operation)) return;
      if (keys.length === 0) {
        setError(intl.formatMessage({ id: "settings.modelProvider.apiKeyManager.empty" }));
        return;
      }
      // 检测读取服务已接受的配置，继续复用先保存再检测的唯一写入路径。
      await onSave(keys);
      if (!guard.isCurrent(operation)) return;
      const results = await onProbe(keys.map((key) => key.id));
      if (!guard.isCurrent(operation)) return;
      const states: Record<string, ProviderApiKeyProbeState> = {};
      const invalid = new Set<string>();
      for (let index = 0; index < results.length; index += 2_000) {
        for (const result of results.slice(index, index + 2_000)) {
          states[result.keyId] = result.status;
          if (result.status === "invalid") invalid.add(result.keyId);
        }
        await yieldToBrowser();
        if (!guard.isCurrent(operation)) return;
      }
      const next = keys.map((key) => (invalid.has(key.id) ? { ...key, enabled: false } : key));
      if (invalid.size > 0) {
        await onSave(next);
        if (!guard.isCurrent(operation)) return;
      }
      setDraft(next);
      setProbeStates(states);
      setIgnoredProbeIds(new Set());
      setInvalidIds(invalid);
    } catch (failure) {
      if (!guard.isCurrent(operation)) return;
      if (failure instanceof ProviderApiKeyImportError) importFailure(failure);
      else setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (guard.isCurrent(operation)) setBusy(null);
    }
  };
  const getProbeState = (id: string) =>
    busy === "probe" ? "pending" : ignoredProbeIds.has(id) ? undefined : probeStates[id];

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
    getProbeState,
  };
}
