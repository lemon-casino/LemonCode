import { useEffect, useRef, useState } from "react";
import {
  isNetworkProxyUrl,
  parseNetworkProxyLines,
  splitNetworkProxyUrl,
  type ProxyConnectivityResult,
  type ProxyProfile,
} from "@lcode/shared";
import { useProviderNetwork } from "@/hooks/useProviderNetwork.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Textarea } from "@/components/ui/textarea.js";
import { ProxyAddressInput } from "./ProxyAddressInput.js";

const PAGE_SIZE = 25;

export function ProxyLibrary() {
  const { intl } = useLCodeIntl();
  const message = (key: string) => intl.formatMessage({ id: `settings.proxy.${key}` });
  const source = useProviderNetwork();
  const profiles = source.state.status === "ready" ? (source.state.view.proxyProfiles ?? []) : [];
  const providers = source.state.status === "ready" ? source.state.view.providers : [];
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [results, setResults] = useState<readonly ProxyConnectivityResult[]>([]);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const activeTest = useRef<string | undefined>(undefined);
  useEffect(
    () => () => {
      if (activeTest.current) void source.cancelTest(activeTest.current).catch(() => undefined);
      activeTest.current = undefined;
    },
    [source.cancelTest],
  );
  const signature = JSON.stringify(profiles);
  const epoch = useRef({ signature, authority: source.authority });
  epoch.current = { signature, authority: source.authority };
  useEffect(() => {
    setResults([]);
  }, [signature, source.authority]);
  useEffect(() => {
    setBusy(false);
    setError(false);
  }, [source.authority]);
  let parsed: ReturnType<typeof parseNetworkProxyLines> = { urls: [], invalidLines: [] };
  let oversized = false;
  try {
    parsed = parseNetworkProxyLines(text);
  } catch {
    oversized = true;
  }
  const perform = async (operation: () => Promise<void>) => {
    const authority = epoch.current.authority;
    setBusy(true);
    setError(false);
    try {
      await operation();
    } catch {
      if (epoch.current.authority === authority) setError(true);
    } finally {
      if (epoch.current.authority === authority) setBusy(false);
    }
  };
  const test = (ids?: readonly string[]) => {
    const operationId = crypto.randomUUID();
    activeTest.current = operationId;
    return perform(async () => {
      const started = epoch.current;
      let tested: readonly ProxyConnectivityResult[];
      try {
        tested = await source.testProxies(ids, operationId);
      } finally {
        if (activeTest.current === operationId) activeTest.current = undefined;
      }
      // 外部编辑/换 Host 后，旧测试结果不能贴到新代理列表。
      if (
        epoch.current.signature === started.signature &&
        epoch.current.authority === started.authority
      )
        setResults((current) => [
          ...current.filter((item) => !tested.some((next) => next.profileId === item.profileId)),
          ...tested,
        ]);
    });
  };
  const visible = profiles.filter((profile) =>
    `${profile.name} ${splitNetworkProxyUrl(profile.httpProxy).address}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const pageIndex = Math.min(page, Math.max(0, Math.ceil(visible.length / PAGE_SIZE) - 1));
  return (
    <section className="min-w-0 space-y-4" data-testid="proxy-library">
      <h3 className="text-ui-lg font-medium">
        {message("library")} · {profiles.length}
      </h3>
      <p className="text-ui-base text-foreground-subtle">{message("importDescription")}</p>
      <label className="block space-y-2 text-ui-base">
        <span>{message("bulkInput")}</span>
        <Textarea
          aria-label={message("bulkInput")}
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={5}
          className="font-mono"
          disabled={busy}
          placeholder={
            "http://user:password@proxy.example:8080\nhttps://proxy.example:8443\nsocks5://user:password@proxy.example:1080"
          }
        />
      </label>
      {parsed.invalidLines.length ? (
        <p role="alert" className="text-ui-sm text-destructive">
          {intl.formatMessage(
            { id: "settings.proxy.invalidLines" },
            { lines: parsed.invalidLines.join(", ") },
          )}
        </p>
      ) : null}
      {oversized ? (
        <p role="alert" className="text-ui-sm text-destructive">
          {message("importLimit")}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={busy || oversized || !parsed.urls.length || Boolean(parsed.invalidLines.length)}
          onClick={() =>
            void perform(async () => {
              await source.importProxies(parsed.urls.join("\n"));
              setText("");
            })
          }
        >
          {message("import")}
        </Button>
        <Button variant="outline" disabled={busy || !profiles.length} onClick={() => void test()}>
          {busy ? message("working") : message("testAll")}
        </Button>
        {busy && activeTest.current ? (
          <Button
            variant="outline"
            onClick={() => void source.cancelTest(activeTest.current!).catch(() => setError(true))}
          >
            {message("cancelTest")}
          </Button>
        ) : null}
      </div>
      <p className="text-ui-sm text-foreground-subtle">{message("testDescription")}</p>
      {error ? (
        <p role="alert" className="text-ui-base text-destructive">
          {message("actionError")}
        </p>
      ) : null}
      {profiles.length ? (
        <Input
          aria-label={message("search")}
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(0);
          }}
          placeholder={message("search")}
        />
      ) : null}
      <div className="space-y-2">
        {visible.slice(pageIndex * PAGE_SIZE, (pageIndex + 1) * PAGE_SIZE).map((profile) => (
          <ProxyLibraryItem
            key={`${profile.id}:${profile.httpProxy}:${profile.name}`}
            profile={profile}
            busy={busy}
            used={providers.some(
              (provider) =>
                provider.effectiveConfig.network?.mode === "profile" &&
                provider.effectiveConfig.network.profileId === profile.id,
            )}
            result={results.find((result) => result.profileId === profile.id)}
            onTest={() => void test([profile.id])}
            onSave={(next) => perform(() => source.saveProxy(next))}
            onDelete={() => void perform(() => source.deleteProxy(profile.id))}
          />
        ))}
      </div>
      {visible.length > PAGE_SIZE ? (
        <div className="flex items-center justify-between gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={pageIndex === 0}
            onClick={() => setPage(pageIndex - 1)}
          >
            {message("previous")}
          </Button>
          <span className="text-ui-sm">
            {pageIndex + 1} / {Math.ceil(visible.length / PAGE_SIZE)}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={(pageIndex + 1) * PAGE_SIZE >= visible.length}
            onClick={() => setPage(pageIndex + 1)}
          >
            {message("next")}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function ProxyLibraryItem({
  profile,
  busy,
  used,
  result,
  onTest,
  onSave,
  onDelete,
}: {
  profile: ProxyProfile;
  busy: boolean;
  used: boolean;
  result?: ProxyConnectivityResult;
  onTest: () => void;
  onSave: (profile: ProxyProfile) => Promise<void>;
  onDelete: () => void;
}) {
  const { intl } = useLCodeIntl();
  const message = (key: string) => intl.formatMessage({ id: `settings.proxy.${key}` });
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(profile);
  return (
    <article
      data-proxy-profile={profile.id}
      className="min-w-0 space-y-3 rounded-lg border border-border p-3"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <button
          type="button"
          className="-mx-2 min-w-0 flex-1 rounded-md px-2 py-1 text-left text-ui-base font-medium hover:bg-hover focus-visible:ring-2 focus-visible:ring-input-border-focused disabled:pointer-events-none disabled:opacity-50"
          aria-expanded={open}
          disabled={busy}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="block break-words">{profile.name}</span>
          <span className="block break-all font-mono text-ui-sm font-normal text-foreground-subtle">
            {splitNetworkProxyUrl(profile.httpProxy).address}
          </span>
        </button>
        {result ? (
          <span
            role="status"
            className={`text-ui-sm ${result.status === "reachable" ? "text-success" : "text-destructive"}`}
          >
            {message(result.status)} · {result.latencyMs} ms
          </span>
        ) : null}
        <Button size="sm" variant="outline" disabled={busy} onClick={onTest}>
          {message("test")}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy || used} onClick={onDelete}>
          {message("delete")}
        </Button>
      </div>
      {used ? <p className="text-ui-sm text-foreground-subtle">{message("inUse")}</p> : null}
      {open ? (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void onSave(draft);
          }}
        >
          <label className="block space-y-1 text-ui-base">
            <span>{message("name")}</span>
            <Input
              value={draft.name}
              disabled={busy}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </label>
          <ProxyAddressInput
            value={draft.httpProxy}
            disabled={busy}
            onChange={(httpProxy) => setDraft({ ...draft, httpProxy })}
          />
          <div className="grid gap-3 sm:grid-cols-2">
            {(["noProxy", "caCertPath"] as const).map((key) => (
              <label key={key} className="min-w-0 space-y-1 text-ui-base">
                <span>
                  {intl.formatMessage({
                    id:
                      key === "noProxy"
                        ? "settings.httpProxyNoProxy"
                        : "settings.httpProxyCaCertPath",
                  })}
                </span>
                <Input
                  disabled={busy}
                  value={draft[key] ?? ""}
                  onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
                />
              </label>
            ))}
          </div>
          <Button
            size="sm"
            disabled={
              busy ||
              !draft.name.trim() ||
              !isNetworkProxyUrl(draft.httpProxy) ||
              JSON.stringify(draft) === JSON.stringify(profile)
            }
          >
            {intl.formatMessage({ id: "settings.dataBaseDirSave" })}
          </Button>
        </form>
      ) : null}
    </article>
  );
}
