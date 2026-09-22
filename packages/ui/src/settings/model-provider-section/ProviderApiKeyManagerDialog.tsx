import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { EyeIcon, EyeOffIcon, PlusIcon, ShieldCheckIcon, Trash2Icon } from "lucide-react";
import type { ProviderApiKey } from "@zcode/provider";
import type { ProviderApiKeyProbeResult } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { createProviderApiKeyOperationGuard, normalizeProviderApiKeys } from "./providerApiKeys.js";

type ProbeState = ProviderApiKeyProbeResult["status"] | "pending";

export function ProviderApiKeyManagerDialog({
  open,
  scopeKey,
  apiKeys,
  onOpenChange,
  onSave,
  onProbe,
}: {
  open: boolean;
  scopeKey: string;
  apiKeys: readonly ProviderApiKey[];
  onOpenChange: (open: boolean) => void;
  onSave: (apiKeys: readonly ProviderApiKey[]) => Promise<void>;
  onProbe: (keyIds: readonly string[]) => Promise<readonly ProviderApiKeyProbeResult[]>;
}) {
  const { intl } = useZCodeIntl();
  const [draft, setDraft] = useState<ProviderApiKey[]>(() => [...apiKeys]);
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState<"save" | "probe" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [probeStates, setProbeStates] = useState<Record<string, ProbeState>>({});
  const apiKeysRef = useRef(apiKeys);
  apiKeysRef.current = apiKeys;
  const operationGuardRef = useRef<ReturnType<typeof createProviderApiKeyOperationGuard> | null>(
    null,
  );
  if (operationGuardRef.current === null) {
    operationGuardRef.current = createProviderApiKeyOperationGuard(null);
  }
  const operationGuard = operationGuardRef.current;

  useLayoutEffect(() => {
    operationGuard.setScope(open ? scopeKey : null);
    if (!open) {
      setBusy(null);
      return () => operationGuard.invalidate();
    }
    // 修复：供应商切换时立即建立新的本地状态边界，旧探测结果不能写入新供应商。
    setDraft([...apiKeysRef.current]);
    setProbeStates({});
    setError(null);
    setBusy(null);
    return () => operationGuard.invalidate();
  }, [open, operationGuard, scopeKey]);

  const normalized = useMemo(() => normalizeProviderApiKeys(draft), [draft]);
  const updateKey = (id: string, patch: Partial<ProviderApiKey>) => {
    setDraft((current) => current.map((key) => (key.id === id ? { ...key, ...patch } : key)));
    setProbeStates((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  };

  const addKey = () => {
    const id = `key-${Date.now()}-${draft.length + 1}`;
    setDraft((current) => [
      ...current,
      { id, label: `API Key ${current.length + 1}`, apiKey: "", enabled: true },
    ]);
  };

  const save = async () => {
    const operation = operationGuard.begin();
    setBusy("save");
    setError(null);
    try {
      await onSave(normalized);
      if (!operationGuard.isCurrent(operation)) return;
      onOpenChange(false);
    } catch (saveError) {
      if (!operationGuard.isCurrent(operation)) return;
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      if (operationGuard.isCurrent(operation)) setBusy(null);
    }
  };

  const probe = async () => {
    const keys = normalizeProviderApiKeys(draft);
    if (keys.length === 0) {
      setError(intl.formatMessage({ id: "settings.modelProvider.apiKeyManager.empty" }));
      return;
    }
    const operation = operationGuard.begin();
    setBusy("probe");
    setError(null);
    setProbeStates(Object.fromEntries(keys.map((key) => [key.id, "pending"])));
    try {
      // 检测必须读取目标 Environment 已接受的配置，先保存同一份草稿再发起并发探测。
      await onSave(keys);
      if (!operationGuard.isCurrent(operation)) return;
      const results = await onProbe(keys.map((key) => key.id));
      if (!operationGuard.isCurrent(operation)) return;
      const nextStates = Object.fromEntries(results.map((result) => [result.keyId, result.status]));
      const invalidIds = new Set(
        results.filter((result) => result.status === "invalid").map((result) => result.keyId),
      );
      const next = keys.map((key) => (invalidIds.has(key.id) ? { ...key, enabled: false } : key));
      setDraft(next);
      if (invalidIds.size > 0) {
        await onSave(next);
        if (!operationGuard.isCurrent(operation)) return;
      }
      setProbeStates(nextStates);
    } catch (probeError) {
      if (!operationGuard.isCurrent(operation)) return;
      setError(probeError instanceof Error ? probeError.message : String(probeError));
    } finally {
      if (operationGuard.isCurrent(operation)) setBusy(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => busy === null && onOpenChange(next)}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {intl.formatMessage({ id: "settings.modelProvider.apiKeyManager.title" })}
          </DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "settings.modelProvider.apiKeyManager.description" })}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-between gap-2">
          <Button type="button" variant="outline" onClick={addKey} disabled={busy !== null}>
            <PlusIcon data-icon="inline-start" />
            {intl.formatMessage({ id: "settings.modelProvider.apiKeyManager.add" })}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={intl.formatMessage({
              id: visible
                ? "settings.modelProvider.hideApiKey"
                : "settings.modelProvider.showApiKey",
            })}
            onClick={() => setVisible((current) => !current)}
          >
            {visible ? <EyeOffIcon /> : <EyeIcon />}
          </Button>
        </div>

        <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
          {draft.length === 0 ? (
            <div className="rounded-xl border border-border bg-surface px-4 py-6 text-center text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "settings.modelProvider.apiKeyManager.empty" })}
            </div>
          ) : (
            draft.map((key, index) => (
              <div
                key={key.id}
                className="grid grid-cols-1 items-center gap-2 rounded-xl border border-border bg-surface p-3 sm:grid-cols-[minmax(7rem,0.35fr)_minmax(12rem,1fr)_auto_auto]"
              >
                <Input
                  size="lg"
                  value={key.label ?? ""}
                  aria-label={intl.formatMessage(
                    { id: "settings.modelProvider.apiKeyManager.label" },
                    { index: index + 1 },
                  )}
                  placeholder={`API Key ${index + 1}`}
                  disabled={busy !== null}
                  onChange={(event) => updateKey(key.id, { label: event.target.value })}
                />
                <div className="min-w-0">
                  <Input
                    size="lg"
                    type={visible ? "text" : "password"}
                    value={key.apiKey}
                    className="font-mono"
                    aria-label={`API Key ${index + 1}`}
                    disabled={busy !== null}
                    onChange={(event) => updateKey(key.id, { apiKey: event.target.value })}
                  />
                  {probeStates[key.id] ? (
                    <p
                      className={`mt-1 text-ui-sm ${
                        probeStates[key.id] === "valid"
                          ? "text-success"
                          : probeStates[key.id] === "invalid"
                            ? "text-destructive"
                            : "text-foreground-subtle"
                      }`}
                    >
                      {intl.formatMessage({
                        id: `settings.modelProvider.apiKeyManager.status.${probeStates[key.id]}`,
                      })}
                    </p>
                  ) : null}
                </div>
                <Switch
                  checked={key.enabled !== false}
                  disabled={busy !== null}
                  aria-label={intl.formatMessage({
                    id: "settings.modelProvider.apiKeyManager.enabled",
                  })}
                  onCheckedChange={(enabled) => updateKey(key.id, { enabled })}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  disabled={busy !== null}
                  aria-label={intl.formatMessage({ id: "common.delete" })}
                  onClick={() =>
                    setDraft((current) => current.filter((item) => item.id !== key.id))
                  }
                >
                  <Trash2Icon />
                </Button>
              </div>
            ))
          )}
        </div>

        {error ? (
          <p role="alert" className="text-ui-sm text-destructive">
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy !== null}
          >
            {intl.formatMessage({ id: "common.cancel" })}
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => void probe()}
            disabled={busy !== null}
          >
            <ShieldCheckIcon data-icon="inline-start" />
            {intl.formatMessage({ id: "settings.modelProvider.apiKeyManager.probe" })}
          </Button>
          <Button type="button" onClick={() => void save()} disabled={busy !== null}>
            {intl.formatMessage({ id: "common.save" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
