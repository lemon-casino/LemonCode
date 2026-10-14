import { useState } from "react";
import type { ProviderUsageRequest } from "@lcode/shared";
import { RefreshCcw } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useProviderUsageStats } from "@/hooks/useProviderUsageStats.js";
import { useProviderAccounts } from "@/hooks/useProviderAccounts.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { ProviderUsageViews, type ProviderUsageView } from "./ProviderUsageViews.js";
export function ProviderUsagePanel() {
  const { intl } = useLCodeIntl();
  const m = (key: string) => intl.formatMessage({ id: `settings.oauthUsage.${key}` });
  const [activeView, setActiveView] = useState<ProviderUsageView>("charts");
  const [quotaRefreshEpoch, setQuotaRefreshEpoch] = useState(0);
  const [filters, setFilters] = useState<{
    range: ProviderUsageRequest["range"];
    provider: string;
    account: string;
    model: string;
    offset: number;
  }>({ range: "24h", provider: "all", account: "all", model: "all", offset: 0 });
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
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <label className="min-w-0 space-y-1 text-ui-sm">
          {m("range")}
          <Select
            value={filters.range}
            onValueChange={(value) =>
              setFilters({
                ...filters,
                range: value as ProviderUsageRequest["range"],
                offset: 0,
              })
            }
          >
            <SelectTrigger className="w-full" aria-label={m("range")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {["24h", "7d", "30d"].map((range) => (
                <SelectItem key={range} value={range}>
                  {m(`range.${range}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <label className="min-w-0 space-y-1 text-ui-sm">
          {m("provider")}
          <Select
            value={filters.provider}
            onValueChange={(value) =>
              setFilters({
                ...filters,
                provider: value,
                account: "all",
                model: "all",
                offset: 0,
              })
            }
          >
            <SelectTrigger className="w-full" aria-label={m("provider")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{m("allProviders")}</SelectItem>
              {providerIds.map((id) => (
                <SelectItem key={id} value={id}>
                  {providerLabel(id)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <label className="min-w-0 space-y-1 text-ui-sm">
          {m("account")}
          <Select
            value={filters.account}
            onValueChange={(value) => setFilters({ ...filters, account: value, offset: 0 })}
          >
            <SelectTrigger className="w-full" aria-label={m("account")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{m("allAccounts")}</SelectItem>
              <SelectItem value="unknown">{m("unattributed")}</SelectItem>
              {accountIds.map((id) => (
                <SelectItem key={id} value={id}>
                  {accountLabel(id)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <label className="min-w-0 space-y-1 text-ui-sm">
          {m("model")}
          <Select
            value={filters.model}
            onValueChange={(value) => setFilters({ ...filters, model: value, offset: 0 })}
          >
            <SelectTrigger className="w-full" aria-label={m("model")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{m("allModels")}</SelectItem>
              {modelIds.map((id) => (
                <SelectItem key={id} value={id}>
                  {id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
      <ProviderUsageViews
        activeView={activeView}
        onViewChange={setActiveView}
        snapshot={snapshot}
        lifetime={lifetime.snapshot}
        overviewUnavailable={Boolean(
          lifetime.error || (lifetime.snapshot && !lifetime.snapshot.activity),
        )}
        chartResetKey={JSON.stringify(filters)}
        providerLabel={providerLabel}
        accountLabel={accountLabel}
        onPage={(offset) => setFilters({ ...filters, offset })}
        quotaAccounts={quotaAccounts}
        accountsLoading={accountsLoading}
        accountsError={Boolean(accountsError)}
        accountRevision={view?.revision ?? 0}
        quotaRefreshEpoch={quotaRefreshEpoch}
        onRefreshQuotas={() => setQuotaRefreshEpoch((epoch) => epoch + 1)}
      />
    </div>
  );
}
