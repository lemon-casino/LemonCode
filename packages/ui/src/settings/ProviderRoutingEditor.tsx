import { useId, useState } from "react";
import { ChevronDown, ChevronRight, CircleHelp } from "lucide-react";
import type { ProviderRoutingPolicy, RoutingStrategy } from "@lcode/shared";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useProviderRouting } from "@/hooks/useProviderRouting.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";

const STRATEGIES = [
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
  const [expanded, setExpanded] = useState(true);
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
      expanded={expanded}
      onToggle={() => setExpanded((value) => !value)}
      onSave={(revision, policy) => source.save(provider.providerId, revision, policy)}
    />
  );
}

function RoutingFields({
  policy,
  revision,
  expanded,
  onToggle,
  onSave,
}: {
  policy?: ProviderRoutingPolicy | null;
  revision: number;
  expanded: boolean;
  onToggle: () => void;
  onSave: (revision: number, policy: ProviderRoutingPolicy | null) => Promise<number>;
}) {
  const { intl } = useLCodeIntl();
  const message = (key: string, values?: Record<string, string>) =>
    intl.formatMessage({ id: `settings.routing.${key}` }, values);
  const id = useId();
  const [strategy, setStrategy] = useState<Selection>(policy?.strategy ?? "reliable-first");
  const [baseRevision, setBaseRevision] = useState(revision);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const save = async () => {
    setBusy(true);
    setError(false);
    try {
      // 新规则只保存策略，旧隐藏参数不再从表单透传。
      const committedRevision = await onSave(baseRevision, {
        version: 1,
        strategy: strategy as RoutingStrategy,
      });
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
      className="min-w-0 space-y-2 rounded-md border border-border p-3 text-ui-base"
      aria-labelledby={`${id}-title`}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <h3 id={`${id}-title`} className="shrink-0 text-ui-base font-medium">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="routing-toggle"
            className="gap-1.5 px-0 font-medium"
            aria-expanded={expanded}
            aria-controls={`${id}-controls`}
            onClick={onToggle}
          >
            {expanded ? (
              <ChevronDown className="size-3.5" aria-hidden="true" />
            ) : (
              <ChevronRight className="size-3.5" aria-hidden="true" />
            )}
            {message("title")}
            <span className="text-ui-caption font-normal text-foreground-subtle">
              {message(expanded ? "collapse" : "expand")}
            </span>
          </Button>
        </h3>
        <div
          id={`${id}-controls`}
          className={expanded ? "flex min-w-0 flex-wrap items-center gap-2" : "hidden"}
        >
          {expanded && (
            <>
              <label htmlFor={`${id}-strategy`} className="sr-only">
                {message("strategy")}
              </label>
              <Select
                value={strategy}
                onValueChange={(value) => setStrategy(value as Selection)}
                disabled={busy}
              >
                <SelectTrigger
                  id={`${id}-strategy`}
                  data-testid="routing-strategy"
                  className="w-44 shrink-0 sm:w-48"
                >
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
              <RoutingHelp
                key={strategy}
                strategy={strategy}
                label={message("help", { strategy: message(strategy) })}
                description={message(`${strategy}.description`)}
              />
              <Button
                type="button"
                data-testid="routing-save"
                size="sm"
                onClick={() => void save()}
                disabled={busy}
              >
                {message(busy ? "saving" : "save")}
              </Button>
            </>
          )}
        </div>
      </div>
      {expanded && error && (
        <div role="alert" className="text-ui-caption text-status-error">
          {message("error")}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setBaseRevision(revision);
              setStrategy(policy?.strategy ?? "reliable-first");
              setError(false);
            }}
          >
            {message("reload")}
          </Button>
        </div>
      )}
    </section>
  );
}

function RoutingHelp({
  strategy,
  label,
  description,
}: {
  strategy: Selection;
  label: string;
  description: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          data-testid="routing-help"
          aria-label={label}
          className="text-foreground-subtle"
          onPointerEnter={(event) => {
            if (event.pointerType === "mouse") setOpen(true);
          }}
          onPointerLeave={(event) => {
            if (event.pointerType === "mouse") setOpen(false);
          }}
          onFocus={() => setOpen(true)}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setOpen(true);
          }}
        >
          <CircleHelp className="size-4" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        role="tooltip"
        data-testid="routing-help-content"
        data-strategy={strategy}
        align="start"
        collisionPadding={12}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        className="w-80 max-w-[calc(100vw-1.5rem)] p-3 text-ui-sm leading-relaxed"
      >
        {description}
      </PopoverContent>
    </Popover>
  );
}
