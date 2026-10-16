import { useId, useState } from "react";
import type { ProviderRoutingPolicy, RoutingStrategy } from "@lcode/shared";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useProviderRouting } from "@/hooks/useProviderRouting.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";

const STRATEGIES = [
  "legacy",
  "reliable-first",
  "primary-backup",
  "share-rotation",
  "headroom-balance",
  "expiry-first",
] as const;
type Selection = (typeof STRATEGIES)[number];
type Target = { providerId?: string; channelId?: string };

export function ProviderRoutingEditor(target: Target) {
  const services = useOptionalServices();
  return services?.providerSettingsService?.setProviderRouting ? (
    <ConnectedRoutingEditor {...target} />
  ) : null;
}

function ConnectedRoutingEditor({ providerId, channelId }: Target) {
  const source = useProviderRouting();
  if (source.state.status !== "ready") return null;
  const view = source.state.view;
  const provider = view.providers.find((item) =>
    providerId
      ? item.providerId === providerId
      : item.effectiveConfig.access?.type === "oauth-account" &&
        item.effectiveConfig.access.channelId === channelId,
  );
  if (!provider) return null;
  return (
    <RoutingFields
      key={`${provider.providerId}:${JSON.stringify(provider.effectiveConfig.routing ?? null)}`}
      policy={provider.effectiveConfig.routing}
      revision={view.revision}
      onSave={(revision, policy) => source.save(provider.providerId, revision, policy)}
    />
  );
}

function RoutingFields({
  policy,
  revision,
  onSave,
}: {
  policy?: ProviderRoutingPolicy | null;
  revision: number;
  onSave: (revision: number, policy: ProviderRoutingPolicy | null) => Promise<number>;
}) {
  const { intl } = useLCodeIntl();
  const message = (key: string) => intl.formatMessage({ id: `settings.routing.${key}` });
  const id = useId();
  const [strategy, setStrategy] = useState<Selection>(policy?.strategy ?? "legacy");
  const [baseRevision, setBaseRevision] = useState(revision);
  const [concurrency, setConcurrency] = useState(String(policy?.maxInFlightPerCandidate ?? 2));
  const [cacheMode, setCacheMode] = useState(policy?.cacheMode ?? "auto");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const valid =
    Number.isInteger(Number(concurrency)) && Number(concurrency) >= 1 && Number(concurrency) <= 64;
  const save = async () => {
    setBusy(true);
    setError(false);
    try {
      const committedRevision = await onSave(
        baseRevision,
        strategy === "legacy"
          ? null
          : {
              ...policy,
              version: 1,
              strategy: strategy as RoutingStrategy,
              maxInFlightPerCandidate: Number(concurrency),
              cacheMode,
            },
      );
      setBaseRevision(committedRevision);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      data-testid="provider-routing-editor"
      className="min-w-0 space-y-3 rounded-md border border-border p-3 text-ui-base"
      aria-labelledby={`${id}-title`}
    >
      <h3 id={`${id}-title`} className="text-ui-base font-medium">
        {message("title")}
      </h3>
      <label htmlFor={`${id}-strategy`} className="text-ui-caption text-foreground-subtle">
        {message("strategy")}
      </label>
      <Select
        value={strategy}
        onValueChange={(value) => setStrategy(value as Selection)}
        disabled={busy}
      >
        <SelectTrigger id={`${id}-strategy`} data-testid="routing-strategy" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {STRATEGIES.map((value) => (
            <SelectItem key={value} value={value} data-testid={`routing-option-${value}`}>
              {message(value)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-ui-caption text-foreground-subtle">{message(`${strategy}.description`)}</p>
      {strategy !== "legacy" && (
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <label htmlFor={`${id}-concurrency`} className="text-ui-caption">
              {message("concurrency")}
            </label>
            <Input
              id={`${id}-concurrency`}
              type="number"
              min={1}
              max={64}
              value={concurrency}
              onChange={(event) => setConcurrency(event.target.value)}
              disabled={busy}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor={`${id}-cache`} className="text-ui-caption">
              {message("cache")}
            </label>
            <Select
              value={cacheMode}
              onValueChange={(value) => setCacheMode(value as typeof cacheMode)}
              disabled={busy}
            >
              <SelectTrigger id={`${id}-cache`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">{message("cache.auto")}</SelectItem>
                <SelectItem value="turn-only">{message("cache.turn-only")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      )}
      {error && (
        <div role="alert" className="text-ui-caption text-status-error">
          {message("error")}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setBaseRevision(revision);
              setStrategy(policy?.strategy ?? "legacy");
              // 冲突重载必须丢弃整个旧草稿，不能用新 revision 提交过期的并发/缓存字段。
              setConcurrency(String(policy?.maxInFlightPerCandidate ?? 2));
              setCacheMode(policy?.cacheMode ?? "auto");
              setError(false);
            }}
          >
            {message("reload")}
          </Button>
        </div>
      )}
      <Button
        data-testid="routing-save"
        size="sm"
        onClick={() => void save()}
        disabled={busy || (strategy !== "legacy" && !valid)}
      >
        {message(busy ? "saving" : "save")}
      </Button>
    </section>
  );
}
