import { useEffect, useId, useRef, useState } from "react";
import {
  setApiKeyRoutingMetadataSchema,
  type ApiKeyRoutingPage,
  type ReadApiKeyRoutingPage,
  type SetApiKeyRoutingMetadata,
  type ApiKeyRoutingMetadata,
} from "@lcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";

type Field = keyof ApiKeyRoutingMetadata;
type Draft = Partial<Record<Field, string>>;
const PAGE_SIZE = 25;
const FIELDS = [
  ["quotaPoolId", "pool", "text"],
  ["weight", "weight", "number"],
  ["priority", "priority", "number"],
  ["cacheGroupId", "cache-group", "text"],
  ["cacheTtlMs", "cache-ttl", "number"],
] as const;
interface Props {
  providerId: string;
  revision: number;
  readPage(input: ReadApiKeyRoutingPage): Promise<ApiKeyRoutingPage>;
  saveMetadata(input: SetApiKeyRoutingMetadata): Promise<number>;
}
function parseDraft(draft: Draft) {
  const patch = Object.fromEntries(
    Object.entries(draft).map(([field, raw]) => {
      const value = raw.trim();
      return [
        field,
        value === ""
          ? null
          : field === "weight" || field === "priority"
            ? Number(value)
            : field === "cacheTtlMs"
              ? Number(value) * 1000
              : value,
      ];
    }),
  );
  const parsed = setApiKeyRoutingMetadataSchema.shape.patch.safeParse(patch);
  return parsed.success ? parsed.data : undefined;
}

export function ApiKeyRoutingBatchEditor(props: Props) {
  const { intl } = useLCodeIntl();
  const [open, setOpen] = useState(false);
  return (
    <section
      data-testid="api-key-routing-batch"
      className="mt-3 min-w-0 rounded-md border border-border p-3 text-ui-base"
    >
      <Button
        data-testid="batch-toggle"
        type="button"
        variant="ghost"
        className="w-full justify-between text-ui-base font-medium"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {intl.formatMessage({ id: "settings.routing.batch.title" })}
        <span aria-hidden="true">{open ? "−" : "+"}</span>
      </Button>
      {open && <ApiKeyRoutingBatchFields {...props} />}
    </section>
  );
}
function ApiKeyRoutingBatchFields({ providerId, revision, readPage, saveMetadata }: Props) {
  const { intl } = useLCodeIntl();
  const message = (key: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id: `settings.routing.batch.${key}` }, values);
  const id = useId();
  const environment = useRef(0),
    request = useRef(0);
  const [page, setPage] = useState<ApiKeyRoutingPage>();
  const [offset, setOffset] = useState(0);
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [draft, setDraft] = useState<Draft>({});
  const [dirty, setDirty] = useState(false),
    [baseRevision, setBaseRevision] = useState(revision);
  const [all, setAll] = useState(false),
    [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    environment.current++;
    setOffset(0);
    setDraft({});
    setDirty(false);
    setSelected(new Set());
    setAll(false);
    setBusy(false);
    setError(false);
    return () => {
      environment.current++;
    };
  }, [providerId, readPage, saveMetadata]);
  useEffect(() => {
    const sequence = ++request.current;
    setLoading(true);
    setPage(undefined);
    void readPage({ providerId, offset, limit: PAGE_SIZE, expectedRevision: revision })
      .then(
        (value) => {
          if (sequence === request.current) setPage(value);
        },
        () => {
          if (sequence === request.current) setError(true);
        },
      )
      .finally(() => {
        if (sequence === request.current) setLoading(false);
      });
    return () => {
      request.current++;
    };
  }, [providerId, readPage, offset, revision, reload]);

  const update = (field: Field, value: string) => {
    if (!dirty) setBaseRevision(page?.revision ?? revision);
    setDirty(true);
    setDraft((current) => ({ ...current, [field]: value }));
  };
  const patch = parseDraft(draft);
  const target = all ? { type: "all" as const } : { type: "ids" as const, keyIds: [...selected] };
  const hasTarget = all ? (page?.total ?? 0) > 0 : selected.size > 0;
  const disabled = loading || busy || !page;
  const apply = async (value: SetApiKeyRoutingMetadata["patch"]) => {
    if (!hasTarget || disabled) return;
    const epoch = environment.current;
    setBusy(true);
    setError(false);
    try {
      const committed = await saveMetadata({
        providerId,
        expectedRevision: dirty ? baseRevision : page!.revision,
        target,
        patch: value,
      });
      if (epoch !== environment.current) return;
      setBaseRevision(committed);
      setDraft({});
      setDirty(false);
      setReload((current) => current + 1);
    } catch {
      if (epoch === environment.current) setError(true);
    } finally {
      if (epoch === environment.current) setBusy(false);
    }
  };
  const reset = () => {
    setDraft({});
    setDirty(false);
    setAll(false);
    setSelected(new Set());
    setBaseRevision(revision);
    setError(false);
    setReload((current) => current + 1);
  };
  return (
    <section className="mt-3 min-w-0 space-y-3 text-ui-base" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} className="sr-only">
        {message("title")}
      </h3>
      <p className="text-ui-caption text-foreground-subtle">{message("description")}</p>
      <p className="text-ui-caption" role="status">
        {loading
          ? message("loading")
          : page
            ? message("summary", {
                total: page.total,
                enabled: page.summary.enabled,
                pools: page.summary.sharedPools,
                caches: page.summary.cacheGroups,
              })
            : message("unavailable")}
      </p>
      <label className="flex min-h-9 items-center gap-2 text-ui-caption">
        <input
          data-testid="batch-target-all"
          type="checkbox"
          checked={all}
          disabled={disabled}
          onChange={(event) => setAll(event.target.checked)}
        />
        {message("all", { total: page?.total ?? 0 })}
      </label>
      <p className="text-ui-caption text-foreground-subtle">
        {message("selected", { count: all ? (page?.total ?? 0) : selected.size })}
      </p>
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        {FIELDS.map(([field, key, type]) => (
          <div key={field} className="min-w-0 space-y-1">
            <label htmlFor={`${id}-${key}`} className="text-ui-caption">
              {message(key)}
            </label>
            <div className="flex min-w-0 gap-1">
              <Input
                id={`${id}-${key}`}
                data-testid={`batch-${key}`}
                type={type}
                className="min-w-0 text-mobile-input-safe sm:text-ui-base"
                value={draft[field] ?? ""}
                placeholder={
                  Object.hasOwn(draft, field) && draft[field] === ""
                    ? message("willClear")
                    : message("keep")
                }
                disabled={disabled}
                onChange={(event) => update(field, event.target.value)}
              />
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={disabled}
                aria-label={`${message(key)}: ${message("clearField")}`}
                onClick={() => update(field, "")}
              >
                {message("clearField")}
              </Button>
            </div>
          </div>
        ))}
      </div>
      {error && (
        <div role="alert" className="text-ui-caption text-status-error">
          {message("error")}
          <Button
            data-testid="batch-reload"
            type="button"
            size="sm"
            variant="ghost"
            onClick={reset}
          >
            {message("reload")}
          </Button>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          data-testid="batch-apply"
          type="button"
          size="sm"
          disabled={disabled || !hasTarget || patch === undefined}
          onClick={() => patch !== undefined && void apply(patch)}
        >
          {message(busy ? "saving" : "apply")}
        </Button>
        <Button
          data-testid="batch-clear"
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || !hasTarget}
          onClick={() => void apply(null)}
        >
          {message("clear")}
        </Button>
      </div>
      <div className="space-y-2">
        {page?.rows.map((row) => (
          <label
            key={row.id}
            data-testid={`batch-row-${row.id}`}
            className="flex min-w-0 gap-2 rounded-md border border-border p-2 text-ui-caption"
          >
            <input
              type="checkbox"
              checked={all || selected.has(row.id)}
              disabled={disabled || all}
              aria-label={row.id}
              onChange={(event) =>
                setSelected((current) => {
                  const next = new Set(current);
                  if (event.target.checked) next.add(row.id);
                  else next.delete(row.id);
                  return next;
                })
              }
            />
            <span className="min-w-0 flex-1 break-words">
              <span className="block font-medium">
                {row.id} · {message(row.enabled ? "enabled" : "disabled")}
              </span>
              <span className="block text-foreground-subtle">
                {message("row", {
                  pool: row.routing?.quotaPoolId ?? message("independent"),
                  weight: row.routing?.weight ?? 1,
                  priority: row.routing?.priority ?? message("directoryOrder"),
                  cache: row.routing?.cacheGroupId ?? message("none"),
                  ttl: row.routing?.cacheTtlMs
                    ? message("ttlValue", { seconds: row.routing.cacheTtlMs / 1000 })
                    : message("none"),
                })}
              </span>
              {row.issues.map((issue) => (
                <span key={issue} className="block text-status-error">
                  {message(`issue.${issue}`)}
                </span>
              ))}
            </span>
          </label>
        ))}
      </div>
      <nav className="flex flex-wrap items-center gap-2" aria-label={message("pages")}>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || offset === 0}
          onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
        >
          {message("previous")}
        </Button>
        <span className="text-ui-caption">
          {message("page", {
            start: page?.total ? offset + 1 : 0,
            end: Math.min(offset + PAGE_SIZE, page?.total ?? 0),
            total: page?.total ?? 0,
          })}
        </span>
        <Button
          data-testid="batch-next"
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || page?.nextOffset === undefined}
          onClick={() => setOffset(page!.nextOffset!)}
        >
          {message("next")}
        </Button>
      </nav>
    </section>
  );
}
