/// <reference types="vite/client" />
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { IServiceAccessor } from "@lcode/services";
import type { Locale } from "@lcode/shared";
import { Button } from "@/components/ui/button.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { useModelProviders } from "@/hooks/useModelProviders.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { LCodeIntlProvider, useLCodeIntl } from "@/i18n/IntlProvider.js";
import { InlineEditableProviderCard } from "@/settings/model-provider-section/InlineEditableProviderCard.js";
import { ProviderDetailFeedbackBoundary } from "@/settings/model-provider-section/ProviderDetailFeedback.js";
import { applyTheme, THEME_OPTIONS, type Theme } from "@/useTheme.js";
import { fixture, PROVIDER_ID, STORAGE_KEY } from "./model-provider-settings-service.js";
import "@lcode/ui/styles.css";

// 只装配这张真实设置卡消费的服务；不启动 Host、Agent 或账号服务。
const services = { providerSettingsService: fixture.service } as IServiceAccessor;

function FixturePage({
  locale,
  onLocaleChange,
  theme,
  onThemeChange,
}: {
  locale: Locale;
  onLocaleChange: (locale: Locale) => void;
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
}) {
  const { intl } = useLCodeIntl();
  const metrics = useSyncExternalStore(fixture.subscribe, fixture.snapshot);
  const providers = useModelProviders({ workspacePath: "/fixture/model-provider-settings" });
  const [mounted, setMounted] = useState(true);
  const [unmountOnProbe, setUnmountOnProbe] = useState(false);
  const unmountArmed = useRef(false);
  const provider = providers.modelProviders.find((item) => item.providerId === PROVIDER_ID);
  const saveProvider = useCallback(
    async (value: Parameters<typeof providers.saveProvider>[0]) => {
      await providers.saveProvider(value);
    },
    [providers.saveProvider],
  );
  const deleteProvider = useCallback(
    () => providers.deleteProvider(PROVIDER_ID),
    [providers.deleteProvider],
  );
  const reorderModels = useCallback(
    (ids: string[]) => providers.reorderProviderModels(PROVIDER_ID, ids),
    [providers.reorderProviderModels],
  );
  const listRemoteModels = useCallback(
    async (id: string) => (await providers.listRemoteModels(id)).models,
    [providers.listRemoteModels],
  );
  useEffect(
    () =>
      fixture.onProbeStarted(() => {
        if (!unmountArmed.current) return;
        unmountArmed.current = false;
        fixture.record("scenario unmount-before-first-result");
        // Modal 挡住背景按钮；先同步卸载，再由可见释放控件放行请求，验证真实取消链路。
        flushSync(() => {
          setMounted(false);
          setUnmountOnProbe(false);
        });
      }),
    [],
  );
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey) return;
      if (event.code === "KeyR") fixture.release();
      else if (event.code === "KeyN") fixture.releaseOne();
      else if (event.code === "KeyU") {
        setMounted(false);
        fixture.record("scenario keyboard-unmount");
      } else return;
      event.preventDefault();
    };
    // Capture 允许在真实 modal 内使用标明的测试快捷键，不改弹框的遮罩或焦点行为。
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, []);
  const accepted = {
    providerId: provider?.providerId ?? null,
    excludedModelIds: provider?.personalConfig.excludedModelIds ?? [],
    models:
      provider?.models.map((model) => ({
        id: model.modelId,
        builtin: model.builtin,
        enabled: model.config.enabled !== false,
        mode: model.useRecommendedConfig === false ? "manual" : "recommended",
        contextWindow: model.config.properties?.contextWindow,
        maxOutputTokens: model.config.optionSpecs?.maxOutputTokens?.max,
        selectable: model.selectable,
      })) ?? [],
  };
  return (
    <main className="fixture-page text-ui-base">
      <h1 className="text-ui-lg font-medium">Model provider settings fixture</h1>
      <p className="text-ui-sm text-foreground-subtle">
        Real UI / hook / Facade. Simulated network only; never enter a real API key.
      </p>
      <div className="fixture-controls" role="group" aria-label="Fixture controls">
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            // 仅移除专用 key；整页重载终止旧夹具实例，不能清理应用其它存储。
            fixture.reset();
            window.location.reload();
          }}
        >
          Reset fixture
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={providers.refreshing}
          onClick={() => {
            void providers.refresh().then(providers.reload);
          }}
        >
          Reload configuration
        </Button>
        <label>
          Language
          <select
            aria-label="Language"
            value={locale}
            onChange={(event) => {
              if (event.target.value === "en-US" || event.target.value === "zh-CN") {
                onLocaleChange(event.target.value);
              }
            }}
          >
            <option value="zh-CN">中文</option>
            <option value="en-US">English</option>
          </select>
        </label>
        <label>
          Theme
          <select
            aria-label="Theme"
            value={theme}
            onChange={(event) => {
              const option = THEME_OPTIONS.find((item) => item.id === event.target.value);
              if (option) onThemeChange(option.id);
            }}
          >
            {THEME_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>
                {intl.formatMessage({ id: option.labelKey })}
              </option>
            ))}
          </select>
        </label>
        <label>
          Mounted provider
          <select
            aria-label="Mounted provider"
            value={mounted ? PROVIDER_ID : "none"}
            onChange={(event) => {
              const next = event.target.value === PROVIDER_ID;
              setMounted(next);
              fixture.record(`mount=${next}`);
            }}
          >
            <option value={PROVIDER_ID}>Test Provider (test)</option>
            <option value="none">None (unmounted)</option>
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={metrics.held}
            onChange={(event) => fixture.setHeld(event.target.checked)}
          />
          Hold probes
        </label>
        <label>
          <input
            type="checkbox"
            checked={unmountOnProbe}
            onChange={(event) => {
              unmountArmed.current = event.target.checked;
              setUnmountOnProbe(event.target.checked);
              if (event.target.checked) fixture.setHeld(true);
            }}
          />
          Unmount before first probe result
        </label>
        <Button
          variant="outline"
          size="sm"
          disabled={!metrics.pending}
          aria-keyshortcuts="Alt+Shift+N"
          onClick={() => fixture.releaseOne()}
        >
          Release one probe
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!metrics.pending}
          aria-keyshortcuts="Alt+Shift+R"
          onClick={() => fixture.release()}
        >
          Release held probes
        </Button>
      </div>
      <p className="text-ui-sm text-foreground-subtle">
        Hold before Sync models or Remove invalid models. Escape closes the dialog; then release or
        switch to None. Inside the dialog: Alt+Shift+N releases one; Alt+Shift+R releases all;
        Alt+Shift+U unmounts. No timers. Turning Hold off affects future requests only.
      </p>
      <section className="fixture-metrics" aria-label="Fixture metrics">
        <dl>
          {(
            [
              ["Catalog loads", "catalog-loads", metrics.catalogLoads],
              ["Started probes", "started", metrics.started],
              ["Active probes", "active", metrics.active],
              ["Max active probes", "max-active", metrics.maxActive],
              ["Mutations", "mutations", metrics.mutations],
              ["Held requests", "pending", metrics.pending],
            ] as const
          ).map(([label, id, value]) => (
            <div key={id}>
              <dt className="text-ui-sm text-foreground-subtle">{label}</dt>
              <dd>
                <output aria-label={label} data-testid={`fixture-${id}`}>
                  {value}
                </output>
              </dd>
            </div>
          ))}
        </dl>
        <p>
          Mounted: <output data-testid="fixture-mounted">{String(mounted)}</output>
        </p>
      </section>
      {providers.loading ? <p role="status">Loading fixture configuration…</p> : null}
      {providers.loadError ? (
        <p role="alert">{providers.loadError.message} — use Reset fixture.</p>
      ) : null}
      {mounted && provider ? (
        <section className="fixture-detail" aria-label="Provider settings">
          <ProviderDetailFeedbackBoundary>
            <InlineEditableProviderCard
              key={provider.providerId}
              provider={provider}
              onSave={saveProvider}
              onDelete={deleteProvider}
              onAddPersonalModel={providers.addPersonalModel}
              onSavePersonalModelDraft={providers.savePersonalModelDraft}
              onSetPersonalModelEnabled={providers.setPersonalModelEnabled}
              onDeletePersonalModel={providers.deletePersonalModel}
              onTestModel={providers.testModelConnectivity}
              onListRemoteModels={listRemoteModels}
              onProbeApiKeys={providers.probeApiKeys}
              onReorderModelIds={reorderModels}
              settingsRevision={providers.providerSettingsView?.revision}
            />
          </ProviderDetailFeedbackBoundary>
        </section>
      ) : (
        <p role="status">Provider card unmounted or deleted.</p>
      )}
      <section className="fixture-state" aria-label="Accepted configuration">
        <h2 className="text-ui-base font-medium">Accepted configuration (no secrets)</h2>
        <pre className="text-ui-sm font-mono" data-testid="fixture-configuration">
          {JSON.stringify(accepted, null, 2)}
        </pre>
      </section>
      <section className="fixture-state" aria-label="Fixture log">
        <h2 className="text-ui-base font-medium">Probe / persistence log</h2>
        <pre className="text-ui-sm font-mono" data-testid="fixture-log" role="log">
          {metrics.logs.join("\n") || "No requests or writes yet."}
        </pre>
        <p className="text-ui-sm text-foreground-subtle">Session key: {STORAGE_KEY}</p>
      </section>
    </main>
  );
}

function FixtureApp() {
  const [locale, setLocale] = useState<Locale>("zh-CN");
  const [theme, setTheme] = useState<Theme>("zai-dark");
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  useEffect(() => {
    applyTheme(theme);
    if (theme !== "system") return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => applyTheme("system");
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [theme]);
  return (
    <ServiceProvider services={services}>
      <TooltipProvider>
        {/* initialLocale 不是受控参数；换 key 真实重挂 Intl，避免污染应用的 locale localStorage。 */}
        <LCodeIntlProvider key={locale} initialLocale={locale}>
          <FixturePage
            locale={locale}
            onLocaleChange={setLocale}
            theme={theme}
            onThemeChange={setTheme}
          />
        </LCodeIntlProvider>
      </TooltipProvider>
    </ServiceProvider>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Fixture root is missing");
createRoot(root).render(<FixtureApp />);
