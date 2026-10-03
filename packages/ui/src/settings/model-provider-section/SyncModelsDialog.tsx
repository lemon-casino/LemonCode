import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCwIcon, ShieldCheckIcon } from "lucide-react";
import { TID_MODEL_PROVIDER_SYNC_MODELS_DIALOG } from "@lcode/shared";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { Input } from "@/components/ui/input.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import {
  MODEL_PROBE_CONCURRENCY,
  filterModelIds,
  normalizeModelIds,
  probeTargetIds,
  runCancelablePool,
  selectedModelIds,
  type SyncModelProbeResult,
} from "./syncModelOperations.js";

export interface SyncModelItem {
  readonly id: string;
  readonly enabled: boolean;
}

interface SyncModelsDialogProps {
  open: boolean;
  configuredModels: readonly SyncModelItem[];
  onOpenChange: (open: boolean) => void;
  onLoadRemoteModels: () => Promise<readonly string[]>;
  onProbeModel: (id: string, signal: AbortSignal) => Promise<SyncModelProbeResult>;
}

export function SyncModelsDialog(props: SyncModelsDialogProps) {
  const { intl } = useLCodeIntl();
  const [remoteIds, setRemoteIds] = useState<readonly string[]>([]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Record<string, SyncModelProbeResult>>({});
  const [checking, setChecking] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<"load" | "probe" | null>(null);
  const [progress, setProgress] = useState<{ completed: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const operationIdRef = useRef(0);
  const operationAbortRef = useRef<AbortController | null>(null);
  const openRef = useRef(props.open);
  const loadRemoteModelsRef = useRef(props.onLoadRemoteModels);
  const configuredModelsRef = useRef(props.configuredModels);

  useEffect(() => {
    // 保存引起的父层投影刷新只更新引用，不能重新拉目录并清空勾选和检测结果。
    loadRemoteModelsRef.current = props.onLoadRemoteModels;
    configuredModelsRef.current = props.configuredModels;
  }, [props.onLoadRemoteModels, props.configuredModels]);

  const beginOperation = useCallback(() => {
    operationAbortRef.current?.abort();
    const abortController = new AbortController();
    operationAbortRef.current = abortController;
    const operationId = operationIdRef.current + 1;
    operationIdRef.current = operationId;
    return { operationId, signal: abortController.signal };
  }, []);

  const isCurrentOperation = useCallback(
    (operationId: number) => openRef.current && operationIdRef.current === operationId,
    [],
  );

  const close = useCallback(() => {
    openRef.current = false;
    operationAbortRef.current?.abort();
    operationAbortRef.current = null;
    operationIdRef.current += 1;
    setBusy(null);
    props.onOpenChange(false);
  }, [props.onOpenChange]);

  const load = useCallback(async () => {
    const { operationId } = beginOperation();
    setBusy("load");
    setRemoteIds([]);
    setSelected(new Set(normalizeModelIds(configuredModelsRef.current.map((model) => model.id))));
    setResults({});
    setChecking(new Set());
    setProgress(null);
    setError(null);
    try {
      const ids = normalizeModelIds(await loadRemoteModelsRef.current());
      if (!isCurrentOperation(operationId)) return;
      setRemoteIds(ids);
      setSelected(
        new Set(
          normalizeModelIds([...ids, ...configuredModelsRef.current.map((model) => model.id)]),
        ),
      );
    } catch (cause) {
      if (isCurrentOperation(operationId)) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (isCurrentOperation(operationId)) setBusy(null);
    }
  }, [beginOperation, isCurrentOperation]);

  useEffect(() => {
    openRef.current = props.open;
    if (props.open) {
      setQuery("");
      void load();
    }
    return () => {
      // 切换供应商会直接卸载组件；不能只在 open=false 时取消旧检测及其入库动作。
      openRef.current = false;
      operationAbortRef.current?.abort();
      operationAbortRef.current = null;
      operationIdRef.current += 1;
    };
  }, [load, props.open]);

  const configured = useMemo(
    () => new Map(props.configuredModels.map((model) => [model.id.trim(), model])),
    [props.configuredModels],
  );
  const rows = useMemo(
    () => normalizeModelIds([...remoteIds, ...configured.keys()]),
    [configured, remoteIds],
  );
  const selectedIds = selectedModelIds(rows, selected);
  const visibleRows = useMemo(() => filterModelIds(rows, query), [rows, query]);
  const searching = query.trim().length > 0;
  // 搜索时提交范围收缩为“匹配项 ∩ 勾选”，数量与“检测并添加指定模型”文案一致。
  const targetIds = probeTargetIds(rows, visibleRows, selected, searching);

  const runProbe = async () => {
    if (busy !== null || targetIds.length === 0) return;
    const ids = targetIds;
    const targetSet = new Set(ids);
    const { operationId, signal } = beginOperation();
    setBusy("probe");
    setProgress({ completed: 0, total: ids.length });
    setError(null);
    setResults((current) =>
      Object.fromEntries(Object.entries(current).filter(([id]) => !targetSet.has(id))),
    );
    try {
      await runCancelablePool({
        items: ids,
        concurrency: MODEL_PROBE_CONCURRENCY,
        shouldContinue: () => !signal.aborted && isCurrentOperation(operationId),
        run: async (id): Promise<SyncModelProbeResult> => {
          setChecking((current) => new Set([...current, id]));
          try {
            return await props.onProbeModel(id, signal);
          } catch (cause) {
            return {
              id,
              success: false,
              message: cause instanceof Error ? cause.message : String(cause),
            };
          }
        },
        onResult: (result) => {
          setResults((current) => ({ ...current, [result.id]: result }));
          setChecking((current) => {
            const next = new Set(current);
            next.delete(result.id);
            return next;
          });
          setProgress((current) =>
            current ? { ...current, completed: current.completed + 1 } : current,
          );
        },
      });
    } finally {
      if (isCurrentOperation(operationId)) {
        setBusy(null);
        setChecking(new Set());
      }
    }
  };

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (open) props.onOpenChange(true);
        else close();
      }}
    >
      <DialogContent
        className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-2xl"
        data-testid={TID_MODEL_PROVIDER_SYNC_MODELS_DIALOG}
      >
        <DialogHeader className="shrink-0 pr-8">
          <DialogTitle>
            {intl.formatMessage({ id: "settings.modelProvider.syncModels" })}
          </DialogTitle>
          <DialogDescription>
            {intl.formatMessage(
              { id: "settings.modelProvider.syncModelsDescription" },
              {
                concurrency: MODEL_PROBE_CONCURRENCY,
              },
            )}
          </DialogDescription>
        </DialogHeader>

        <Input
          type="search"
          value={query}
          placeholder={intl.formatMessage({ id: "settings.modelProvider.syncModelsSearch" })}
          aria-label={intl.formatMessage({ id: "settings.modelProvider.syncModelsSearch" })}
          onChange={(event) => setQuery(event.target.value)}
          className="shrink-0 text-mobile-input-safe sm:text-ui-base"
        />
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => void load()}
            disabled={busy !== null}
          >
            <RefreshCwIcon
              data-icon="inline-start"
              className={busy === "load" ? "animate-spin" : undefined}
            />
            {intl.formatMessage({ id: "settings.modelProvider.syncModelsRefresh" })}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy !== null || visibleRows.length === 0}
            onClick={() => setSelected(new Set(visibleRows))}
          >
            {intl.formatMessage({
              id: searching
                ? "settings.modelProvider.syncModelsSelectResults"
                : "settings.modelProvider.syncModelsSelectAll",
            })}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy !== null || selectedIds.length === 0}
            onClick={() => setSelected(new Set())}
          >
            {intl.formatMessage({ id: "settings.modelProvider.syncModelsClearSelection" })}
          </Button>
          <span className="text-ui-sm text-foreground-subtle">
            {searching
              ? `${intl.formatMessage(
                  { id: "settings.modelProvider.syncModelsSearchResults" },
                  { count: visibleRows.length },
                )} · `
              : null}
            {intl.formatMessage(
              { id: "settings.modelProvider.syncModelsSelection" },
              {
                selected: selectedIds.length,
                total: rows.length,
              },
            )}
          </span>
        </div>

        {progress ? (
          <p className="text-ui-sm text-foreground-subtle" role="status">
            {intl.formatMessage({ id: "settings.modelProvider.syncModelsProgress" }, progress)}
          </p>
        ) : null}

        <div className="min-h-0 max-h-80 overflow-y-auto rounded-xl border border-border bg-surface">
          {visibleRows.length === 0 && busy !== "load" ? (
            <div className="px-4 py-8 text-center text-ui-base text-foreground-subtle">
              {intl.formatMessage({
                id: searching
                  ? "settings.modelProvider.syncModelsNoResults"
                  : "settings.modelProvider.syncModelsEmpty",
              })}
            </div>
          ) : null}
          {visibleRows.map((id) => {
            const model = configured.get(id);
            const result = results[id];
            const pending = checking.has(id);
            return (
              <label
                key={id}
                className="flex min-h-10 items-start gap-3 border-b border-border px-3 py-2 last:border-b-0"
              >
                <Checkbox
                  className="mt-0.5"
                  checked={selected.has(id)}
                  disabled={busy !== null}
                  aria-label={id}
                  onCheckedChange={(checked) =>
                    setSelected((current) => {
                      const next = new Set(current);
                      if (checked === true) next.add(id);
                      else next.delete(id);
                      return next;
                    })
                  }
                />
                <span className="min-w-0 flex-1">
                  <span className="block break-all font-mono text-ui-base">{id}</span>
                  {result?.message ? (
                    <span className="mt-1 block break-words text-ui-sm text-destructive">
                      {result.message}
                    </span>
                  ) : null}
                </span>
                <span className="flex shrink-0 flex-col items-end gap-1">
                  <span className="text-ui-sm text-foreground-subtle">
                    {intl.formatMessage({
                      id: model
                        ? model.enabled
                          ? "settings.modelProvider.syncModelsConfigured"
                          : "settings.modelProvider.syncModelsDisabled"
                        : "settings.modelProvider.syncModelsRemote",
                    })}
                  </span>
                  {pending ? (
                    <span className="text-ui-sm text-foreground-subtle">
                      {intl.formatMessage({ id: "settings.modelProvider.syncModelsChecking" })}
                    </span>
                  ) : result ? (
                    <span
                      className={
                        result.success ? "text-ui-sm text-success" : "text-ui-sm text-destructive"
                      }
                    >
                      {intl.formatMessage({
                        id: result.success
                          ? "settings.modelProvider.syncModelsProbeSuccess"
                          : result.stage === "save"
                            ? "settings.modelProvider.syncModelsSaveFailed"
                            : "settings.modelProvider.syncModelsFailed",
                      })}
                    </span>
                  ) : null}
                </span>
              </label>
            );
          })}
        </div>

        {error ? (
          <p role="alert" className="text-ui-sm text-destructive">
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={close}>
            {intl.formatMessage({ id: "common.close" })}
          </Button>
          <Button
            type="button"
            disabled={busy !== null || targetIds.length === 0}
            onClick={() => void runProbe()}
          >
            {busy === "probe" ? (
              <RefreshCwIcon data-icon="inline-start" className="animate-spin" />
            ) : (
              <ShieldCheckIcon data-icon="inline-start" />
            )}
            {intl.formatMessage(
              {
                id: searching
                  ? "settings.modelProvider.syncModelsCheckSearch"
                  : rows.length > 0 && selectedIds.length === rows.length
                    ? "settings.modelProvider.syncModelsCheckAll"
                    : "settings.modelProvider.syncModelsCheckSelected",
              },
              { count: targetIds.length },
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
