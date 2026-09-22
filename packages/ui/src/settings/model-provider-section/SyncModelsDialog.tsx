import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCwIcon, ShieldCheckIcon } from "lucide-react";
import { TID_MODEL_PROVIDER_SYNC_MODELS_DIALOG } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  runCancelablePool,
  runSequentialModelMutation,
  selectedModelIds,
} from "./syncModelOperations.js";

const MODEL_PROBE_CONCURRENCY = 4;

export interface SyncModelItem {
  readonly id: string;
  readonly enabled: boolean;
}

export interface SyncModelProbeResult {
  readonly id: string;
  readonly success: boolean;
  readonly message?: string;
}

interface SyncModelsDialogProps {
  open: boolean;
  configuredModels: readonly SyncModelItem[];
  onOpenChange: (open: boolean) => void;
  onLoadRemoteModels: () => Promise<readonly string[]>;
  onAddModel: (id: string) => Promise<void>;
  onProbeModel: (id: string, signal: AbortSignal) => Promise<SyncModelProbeResult>;
}

type SyncOperation = "load" | "probe" | "sync";

export function SyncModelsDialog(props: SyncModelsDialogProps) {
  const { intl } = useZCodeIntl();
  const [remoteIds, setRemoteIds] = useState<readonly string[]>([]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [results, setResults] = useState<Record<string, SyncModelProbeResult>>({});
  const [busy, setBusy] = useState<SyncOperation | null>(null);
  const [progress, setProgress] = useState<{ completed: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const operationIdRef = useRef(0);
  const operationAbortRef = useRef<AbortController | null>(null);
  const openRef = useRef(props.open);
  const loadRemoteModelsRef = useRef(props.onLoadRemoteModels);

  useEffect(() => {
    // 修复：保存模型会换掉父层目录回调；仅更新回调引用，不能重新加载并清空勾选/检测结果。
    loadRemoteModelsRef.current = props.onLoadRemoteModels;
  }, [props.onLoadRemoteModels]);

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
    setProgress(null);
    props.onOpenChange(false);
  }, [props.onOpenChange]);

  const load = useCallback(async () => {
    const { operationId } = beginOperation();
    setBusy("load");
    setProgress(null);
    setError(null);
    try {
      const ids = await loadRemoteModelsRef.current();
      if (!isCurrentOperation(operationId)) return;
      setRemoteIds(ids);
      setSelected(new Set(ids));
      setResults({});
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
      void load();
      return;
    }
    operationAbortRef.current?.abort();
    operationAbortRef.current = null;
    operationIdRef.current += 1;
  }, [load, props.open]);

  const configured = useMemo(
    () => new Map(props.configuredModels.map((model) => [model.id, model])),
    [props.configuredModels],
  );
  const rows = useMemo(
    () => [...new Set([...remoteIds, ...configured.keys()])],
    [configured, remoteIds],
  );

  const run = async (
    operation: Exclude<SyncOperation, "load">,
    action: (operationId: number, signal: AbortSignal) => Promise<void>,
  ) => {
    const { operationId, signal } = beginOperation();
    setBusy(operation);
    setProgress(null);
    setError(null);
    try {
      await action(operationId, signal);
    } catch (cause) {
      if (isCurrentOperation(operationId)) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (isCurrentOperation(operationId)) {
        setBusy(null);
        setProgress(null);
      }
    }
  };

  const mutateSequentially = async (
    ids: readonly string[],
    operationId: number,
    mutate: (id: string) => Promise<void>,
  ) => {
    await runSequentialModelMutation({
      items: ids,
      shouldContinue: () => isCurrentOperation(operationId),
      run: mutate,
      onProgress: (completed) => setProgress({ completed, total: ids.length }),
    });
  };

  const probe = async (ids: readonly string[], operationId: number, signal: AbortSignal) => {
    setProgress({ completed: 0, total: ids.length });
    await runCancelablePool({
      items: ids,
      concurrency: MODEL_PROBE_CONCURRENCY,
      shouldContinue: () => !signal.aborted && isCurrentOperation(operationId),
      run: (id) => props.onProbeModel(id, signal),
      onResult: (result) => {
        setResults((current) => ({ ...current, [result.id]: result }));
        setProgress((current) =>
          current ? { ...current, completed: current.completed + 1 } : current,
        );
      },
    });
  };

  const selectedIds = selectedModelIds(rows, selected);

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (open) props.onOpenChange(true);
        else close();
      }}
    >
      <DialogContent className="max-w-2xl" data-testid={TID_MODEL_PROVIDER_SYNC_MODELS_DIALOG}>
        <DialogHeader>
          <DialogTitle>
            {intl.formatMessage({ id: "settings.modelProvider.syncModels" })}
          </DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "settings.modelProvider.syncModelsDescription" })}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2">
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
            disabled={busy !== null || rows.length === 0}
            onClick={() => setSelected(new Set(rows))}
          >
            {intl.formatMessage({ id: "settings.modelProvider.syncModelsSelectAll" })}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy !== null || selectedIds.length === 0}
            onClick={() => setSelected(new Set())}
          >
            {intl.formatMessage({ id: "settings.modelProvider.syncModelsClearSelection" })}
          </Button>
        </div>

        {progress ? (
          <p className="text-ui-sm text-foreground-subtle" role="status">
            {intl.formatMessage({ id: "settings.modelProvider.syncModelsProgress" }, progress)}
          </p>
        ) : null}

        <div className="max-h-80 overflow-y-auto rounded-xl border border-border bg-surface">
          {rows.length === 0 && busy !== "load" ? (
            <div className="px-4 py-8 text-center text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "settings.modelProvider.syncModelsEmpty" })}
            </div>
          ) : null}
          {rows.map((id) => {
            const model = configured.get(id);
            const result = results[id];
            return (
              <label
                key={id}
                className="flex min-h-10 items-center gap-3 border-b border-border px-3 py-2 last:border-b-0"
              >
                <Checkbox
                  checked={selected.has(id)}
                  onCheckedChange={(checked) =>
                    setSelected((current) => {
                      const next = new Set(current);
                      if (checked === true) next.add(id);
                      else next.delete(id);
                      return next;
                    })
                  }
                />
                <span className="min-w-0 flex-1 truncate font-mono text-ui-base">{id}</span>
                <span className="text-ui-sm text-foreground-subtle">
                  {intl.formatMessage({
                    id: model
                      ? model.enabled
                        ? "settings.modelProvider.syncModelsConfigured"
                        : "settings.modelProvider.syncModelsDisabled"
                      : remoteIds.includes(id)
                        ? "settings.modelProvider.syncModelsRemote"
                        : "settings.modelProvider.syncModelsLocalOnly",
                  })}
                </span>
                {result ? (
                  <span
                    className={
                      result.success ? "text-ui-sm text-success" : "text-ui-sm text-destructive"
                    }
                  >
                    {intl.formatMessage({
                      id: result.success
                        ? "settings.modelProvider.syncModelsProbeSuccess"
                        : "settings.modelProvider.syncModelsFailed",
                    })}
                  </span>
                ) : null}
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
            variant="secondary"
            disabled={busy !== null || selectedIds.length === 0}
            onClick={() =>
              void run("probe", (operationId, signal) => probe(selectedIds, operationId, signal))
            }
          >
            <ShieldCheckIcon data-icon="inline-start" />
            {intl.formatMessage({ id: "settings.modelProvider.syncModelsProbe" })}
          </Button>
          <Button
            type="button"
            disabled={busy !== null || selectedIds.length === 0}
            onClick={() =>
              void run("sync", async (operationId, signal) => {
                await mutateSequentially(selectedIds, operationId, props.onAddModel);
                if (isCurrentOperation(operationId)) await probe(selectedIds, operationId, signal);
              })
            }
          >
            {intl.formatMessage({ id: "settings.modelProvider.syncModelsConfigure" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
