import { lazy, useState } from "react";
import type { ProviderUsageRequest } from "@lcode/shared";
import { RefreshCcw } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useProviderUsageStats } from "@/hooks/useProviderUsageStats.js";
import { useProviderAccounts } from "@/hooks/useProviderAccounts.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { UsageChartLoadBoundary } from "./UsageChartLoadBoundary.js";
import { ProviderQuotaCard } from "./ProviderQuotaCard.js";
import { ProviderUsageOverview } from "./ProviderUsageOverview.js";
import {
  ProviderUsageGroups,
  ProviderUsageRequests,
  ProviderUsageSummary,
} from "./ProviderUsageDetails.js";

const ProviderUsageChart = lazy(() =>
  import("./ProviderUsageChart.js").then((module) => ({ default: module.ProviderUsageChart })),
);
const ProviderModelUsageChart = lazy(() =>
  import("./ProviderModelUsageChart.js").then((module) => ({
    default: module.ProviderModelUsageChart,
  })),
);
const selectClass =
  "min-h-8 w-full min-w-0 rounded-md border border-input-border bg-input px-2 text-ui-base text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused";

export function ProviderUsagePanel() {
  const { intl } = useLCodeIntl();
  const m = (key: string) => intl.formatMessage({ id: `settings.oauthUsage.${key}` });
  const [quotaRefreshEpoch, setQuotaRefreshEpoch] = useState(0);
  const [filters, setFilters] = useState<{
    range: ProviderUsageRequest["range"];
    provider: string;
    account: string;
    model: string;
    offset: number;
  }>({ range: "7d", provider: "all", account: "all", model: "all", offset: 0 });
  const {
    view,
    loading: accountsLoading,
    error: accountsError,
    refresh: refreshAccounts,
  } = useProviderAccounts();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  // 目录查询不带局部筛选，避免筛选后的聚合把其它供应商/已移除账号从下拉列表隐藏。
  const catalog = useProviderUsageStats({ range: "all", timeZone, limit: 1 });
  const queryFilters = {
    timeZone,
    ...(filters.provider === "all" ? {} : { providerId: filters.provider }),
    ...(filters.account === "all"
      ? {}
      : { connectionId: filters.account === "unknown" ? null : filters.account }),
    ...(filters.model === "all" ? {} : { modelId: filters.model }),
  };
  const hasFilter =
    filters.provider !== "all" || filters.account !== "all" || filters.model !== "all";
  const filteredLifetime = useProviderUsageStats(
    { ...queryFilters, range: "all", limit: 1 },
    { enabled: hasFilter },
  );
  const lifetime = hasFilter ? filteredLifetime : catalog;
  const { snapshot, loading, error, refresh } = useProviderUsageStats({
    ...queryFilters,
    range: filters.range,
    offset: filters.offset,
    limit: 25,
  });
  const accounts = view?.accounts ?? [];
  const providerIds = [
    ...new Set([
      ...accounts.map((account) => `oauth:${account.channelId}`),
      ...(catalog.snapshot?.providers.map((group) => group.providerId) ?? []),
    ]),
  ];
  const providerLabel = (id: string) =>
    view?.channels.find((channel) => `oauth:${channel.id}` === id)?.name ?? id;
  const accountLabel = (id: string | null) =>
    id === null
      ? m("unattributed")
      : (accounts.find((account) => account.connectionId === id)?.displayName ??
        `${m("removed")} · ${id.slice(0, 8)}`);
  const visibleAccounts = accounts.filter(
    (account) => filters.provider === "all" || `oauth:${account.channelId}` === filters.provider,
  );
  const historicalAccounts =
    catalog.snapshot?.accounts.filter(
      (group) => filters.provider === "all" || group.providerId === filters.provider,
    ) ?? [];
  const accountIds = [
    ...new Set([
      ...visibleAccounts.map((account) => account.connectionId),
      ...historicalAccounts.flatMap((group) =>
        group.accountConnectionId ? [group.accountConnectionId] : [],
      ),
    ]),
  ];
  const modelIds = [
    ...new Set([
      ...(catalog.snapshot?.models
        .filter((group) => filters.provider === "all" || group.providerId === filters.provider)
        .flatMap((group) => (group.modelId ? [group.modelId] : [])) ?? []),
      ...visibleAccounts.flatMap((account) => account.models.map((model) => model.id)),
    ]),
  ];
  const quotaAccounts = visibleAccounts.filter(
    (account) => filters.account === "all" || account.connectionId === filters.account,
  );
  return (
    <div className="min-w-0 space-y-5" data-testid="oauth-usage-panel">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-ui-lg font-medium">{m("title")}</h2>
          <p className="mt-1 text-ui-sm text-foreground-subtle">{m("source")}</p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            refresh();
            catalog.refresh();
            filteredLifetime.refresh();
            void refreshAccounts();
            setQuotaRefreshEpoch((epoch) => epoch + 1);
          }}
        >
          <RefreshCcw />
          {m("refresh")}
        </Button>
      </div>
      <ProviderUsageOverview snapshot={lifetime.snapshot} />
      {lifetime.error || (lifetime.snapshot && !lifetime.snapshot.activity) ? (
        <p role="status" className="text-ui-sm text-foreground-subtle">
          {m("overviewUnavailable")}
        </p>
      ) : null}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <label className="min-w-0 space-y-1 text-ui-sm">
          {m("range")}
          <select
            aria-label={m("range")}
            className={selectClass}
            value={filters.range}
            onChange={(event) =>
              setFilters({
                ...filters,
                range: event.target.value as ProviderUsageRequest["range"],
                offset: 0,
              })
            }
          >
            {["24h", "7d", "30d"].map((range) => (
              <option key={range} value={range}>
                {m(`range.${range}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="min-w-0 space-y-1 text-ui-sm">
          {m("provider")}
          <select
            aria-label={m("provider")}
            className={selectClass}
            value={filters.provider}
            onChange={(event) =>
              setFilters({
                ...filters,
                provider: event.target.value,
                account: "all",
                model: "all",
                offset: 0,
              })
            }
          >
            <option value="all">{m("allProviders")}</option>
            {providerIds.map((id) => (
              <option key={id} value={id}>
                {providerLabel(id)}
              </option>
            ))}
          </select>
        </label>
        <label className="min-w-0 space-y-1 text-ui-sm">
          {m("account")}
          <select
            aria-label={m("account")}
            className={selectClass}
            value={filters.account}
            onChange={(event) => setFilters({ ...filters, account: event.target.value, offset: 0 })}
          >
            <option value="all">{m("allAccounts")}</option>
            <option value="unknown">{m("unattributed")}</option>
            {accountIds.map((id) => (
              <option key={id} value={id}>
                {accountLabel(id)}
              </option>
            ))}
          </select>
        </label>
        <label className="min-w-0 space-y-1 text-ui-sm">
          {m("model")}
          <select
            aria-label={m("model")}
            className={selectClass}
            value={filters.model}
            onChange={(event) => setFilters({ ...filters, model: event.target.value, offset: 0 })}
          >
            <option value="all">{m("allModels")}</option>
            {modelIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="text-ui-sm text-foreground-subtle">{m("retention")}</p>
      {loading ? (
        <p role="status" className="text-ui-sm text-foreground-subtle">
          {m("loading")}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="rounded-xl border border-border p-4 text-ui-sm text-destructive">
          {m(error === "workspace" ? "workspaceUnavailable" : "unavailable")}
        </p>
      ) : null}
      {snapshot ? (
        <>
          <ProviderUsageSummary summary={snapshot.summary} />
          {!snapshot.summary.requestCount ? (
            <p className="rounded-xl border border-dashed border-border p-6 text-center text-ui-sm text-foreground-subtle">
              {m("empty")}
            </p>
          ) : (
            <UsageChartLoadBoundary
              scope="oauth-usage"
              resetKeys={[snapshot.generatedAt, filters]}
              loadingDescription={m("loading")}
            >
              <ProviderUsageChart snapshot={snapshot} />
            </UsageChartLoadBoundary>
          )}
          {snapshot.summary.requestCount > 0 && (
            <UsageChartLoadBoundary
              scope="oauth-model-usage"
              resetKeys={[snapshot.generatedAt, filters]}
              loadingDescription={m("loading")}
            >
              <ProviderModelUsageChart snapshot={snapshot} providerLabel={providerLabel} />
            </UsageChartLoadBoundary>
          )}
          <div className="grid min-w-0 gap-4 xl:grid-cols-3">
            <ProviderUsageGroups
              title={m("providers")}
              groups={snapshot.providers}
              label={(group) => providerLabel(group.providerId)}
            />
            <ProviderUsageGroups
              title={m("accounts")}
              groups={snapshot.accounts}
              label={(group) =>
                `${providerLabel(group.providerId)} · ${accountLabel(group.accountConnectionId)}`
              }
            />
            <ProviderUsageGroups
              title={m("models")}
              groups={snapshot.models}
              label={(group) =>
                `${providerLabel(group.providerId)} · ${group.modelId ?? m("unknown")}`
              }
            />
          </div>
          <ProviderUsageRequests
            snapshot={snapshot}
            providerLabel={providerLabel}
            accountLabel={accountLabel}
            onPage={(offset) => setFilters({ ...filters, offset })}
          />
        </>
      ) : null}
      <section className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-ui-base font-medium">{m("quotaTitle")}</h3>
            <p className="mt-1 text-ui-sm text-foreground-subtle">{m("quotaSource")}</p>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={!quotaAccounts.length}
            data-testid="refresh-visible-quotas"
            onClick={() => setQuotaRefreshEpoch((epoch) => epoch + 1)}
          >
            <RefreshCcw />
            {m("refreshQuotas")}
          </Button>
        </div>
        {accountsLoading ? (
          <p className="text-ui-sm text-foreground-subtle">{m("loading")}</p>
        ) : null}
        {accountsError ? (
          <p role="status" className="text-ui-sm text-destructive">
            {m("accountsUnavailable")}
          </p>
        ) : null}
        {!accountsLoading && !quotaAccounts.length ? (
          <p className="text-ui-sm text-foreground-subtle">{m("noQuotaAccounts")}</p>
        ) : null}
        <div className="grid gap-3 md:grid-cols-2">
          {quotaAccounts.map((account) => (
            <ProviderQuotaCard
              key={account.connectionId}
              account={account}
              providerName={providerLabel(`oauth:${account.channelId}`)}
              revision={view?.revision ?? 0}
              refreshEpoch={quotaRefreshEpoch}
            />
          ))}
        </div>
      </section>
    </div>
  );
}
