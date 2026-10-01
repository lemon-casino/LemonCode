import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { RefreshCwIcon } from "lucide-react";
import type { ModelConnectivityResult } from "@lcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { MODEL_PROBE_CONCURRENCY, normalizeModelIds } from "./syncModelOperations.js";
import {
  removeInvalidModels,
  type RemoveInvalidModelResult,
} from "./removeInvalidModelOperations.js";

interface RemoveInvalidModelsDialogProps {
  modelIds: readonly string[];
  onClose: () => void;
  onTestModel: (id: string, options: { mode: "temporary" }) => Promise<ModelConnectivityResult>;
  onDeleteModel: (id: string, options: { silentFeedback: true }) => void | Promise<void>;
}

const resultColors = {
  valid: "text-success",
  removed: "text-success",
  unconfirmed: "text-warning",
  deleteFailed: "text-destructive",
};

export function RemoveInvalidModelsDialog(props: RemoveInvalidModelsDialogProps) {
  const { intl } = useLCodeIntl();
  const [ids] = useState(() => normalizeModelIds(props.modelIds));
  const [results, setResults] = useState<ReadonlyMap<string, RemoveInvalidModelResult>>(new Map());
  const [checking, setChecking] = useState<ReadonlySet<string>>(new Set());
  const [running, setRunning] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const callbacksRef = useRef({ probe: props.onTestModel, remove: props.onDeleteModel });
  const abortRef = useRef<AbortController | null>(null);

  useLayoutEffect(() => {
    // 配置刷新只更新命令引用，不重启队列或用最新成员覆盖点击时的检测快照。
    callbacksRef.current = { probe: props.onTestModel, remove: props.onDeleteModel };
  }, [props.onTestModel, props.onDeleteModel]);

  useLayoutEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    const abort = new AbortController();
    abortRef.current = abort;
    setResults(new Map());
    setChecking(new Set());
    setRunning(true);
    setError(null);
    void removeInvalidModels({
      ids,
      signal: abort.signal,
      probe: (id, options) => callbacksRef.current.probe(id, options),
      remove: (id, options) => callbacksRef.current.remove(id, options),
      onStart: (id) => setChecking((current) => new Set([...current, id])),
      onResult: (result) => {
        setResults((current) => new Map(current).set(result.id, result));
        setChecking((current) => {
          const next = new Set(current);
          next.delete(result.id);
          return next;
        });
      },
    })
      .catch((cause) => {
        if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!abort.signal.aborted) setRunning(false);
      });
    return () => abort.abort();
  }, [ids]);

  const close = () => {
    // 关闭事件先取消，再让父层卸载；不能等动画或下一次 effect 才阻止迟到结果删除。
    abortRef.current?.abort();
    props.onClose();
  };
  const summary = { total: results.size, valid: 0, removed: 0, unconfirmed: 0, deleteFailed: 0 };
  for (const result of results.values()) summary[result.status] += 1;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        className="flex max-h-[calc(100dvh-2rem)] flex-col overflow-y-auto sm:max-w-2xl"
        data-testid="model-provider-remove-invalid-dialog"
      >
        <DialogHeader className="shrink-0 pr-8">
          <DialogTitle>
            {intl.formatMessage({ id: "settings.modelProvider.removeInvalid.title" })}
          </DialogTitle>
          <DialogDescription>
            {intl.formatMessage(
              { id: "settings.modelProvider.removeInvalid.description" },
              { concurrency: MODEL_PROBE_CONCURRENCY },
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 space-y-3 overflow-y-auto">
          <div
            className="space-y-1 text-ui-sm text-foreground-subtle"
            role="status"
            aria-live="polite"
          >
            <p>
              {intl.formatMessage(
                { id: "settings.modelProvider.removeInvalid.progress" },
                { completed: results.size, total: ids.length },
              )}
            </p>
            {!running ? (
              <>
                <p data-testid="model-provider-remove-invalid-summary">
                  {intl.formatMessage(
                    { id: "settings.modelProvider.removeInvalid.summary" },
                    summary,
                  )}
                </p>
                {summary.removed === 0 ? (
                  <p>
                    {intl.formatMessage({ id: "settings.modelProvider.removeInvalid.noneRemoved" })}
                  </p>
                ) : null}
              </>
            ) : null}
          </div>
          <ul className="rounded-xl border border-border bg-surface">
            {ids.map((id) => {
              const result = results.get(id);
              const pending = checking.has(id);
              const status = result?.status ?? (pending ? "checking" : "pending");
              const message =
                result?.message ||
                (result?.status === "unconfirmed"
                  ? intl.formatMessage({ id: "settings.modelProvider.removeInvalid.unknownReason" })
                  : undefined);
              return (
                <li
                  key={id}
                  className="flex flex-col gap-1 border-b border-border px-3 py-2 last:border-b-0 sm:flex-row sm:items-start sm:gap-3"
                >
                  <div className="min-w-0 flex-1">
                    <span className="block break-all font-mono text-ui-base">{id}</span>
                    {message ? (
                      <span
                        className={`mt-1 block break-words text-ui-sm ${
                          result?.status === "deleteFailed"
                            ? "text-destructive"
                            : "text-foreground-subtle"
                        }`}
                      >
                        {message}
                      </span>
                    ) : null}
                  </div>
                  <span
                    className={`flex shrink-0 items-center gap-1 text-ui-sm ${
                      result ? resultColors[result.status] : "text-foreground-subtle"
                    }`}
                  >
                    {pending ? (
                      <RefreshCwIcon className="size-3.5 animate-spin" aria-hidden="true" />
                    ) : null}
                    {intl.formatMessage({ id: `settings.modelProvider.removeInvalid.${status}` })}
                  </span>
                </li>
              );
            })}
          </ul>
          {error ? (
            <p role="alert" className="text-ui-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter className="shrink-0">
          <Button type="button" variant="outline" onClick={close}>
            {intl.formatMessage({ id: "common.close" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
