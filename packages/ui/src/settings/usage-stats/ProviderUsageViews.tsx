import { lazy } from "react";
import type { ProviderAccount, ProviderUsageSnapshot } from "@lcode/shared";
import { RefreshCcw } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { UsageChartLoadBoundary } from "./UsageChartLoadBoundary.js";
import { ProviderQuotaCard } from "./ProviderQuotaCard.js";
import { ProviderTokenActivity } from "./ProviderTokenActivity.js";
import { ProviderUsageOverview } from "./ProviderUsageOverview.js";
import {
  ProviderUsageGroups,
  ProviderUsageRequests,
  ProviderUsageSummary,
} from "./ProviderUsageDetails.js";
import {
  USAGE_STATS_TABS_LIST_CLASS,
  USAGE_STATS_TABS_TRIGGER_CLASS,
} from "./usageStatsUiParts.js";

const ProviderUsageChart = lazy(() =>
  import("./ProviderUsageChart.js").then((module) => ({ default: module.ProviderUsageChart })),
);
const ProviderModelUsageChart = lazy(() =>
  import("./ProviderModelUsageChart.js").then((module) => ({
    default: module.ProviderModelUsageChart,
  })),
);
const views = ["charts", "statistics", "requests-quotas"] as const;
export type ProviderUsageView = (typeof views)[number];

export function ProviderUsageViews({
  activeView,
  onViewChange,
  snapshot,
  lifetime,
  overviewUnavailable,
  chartResetKey,
  providerLabel,
  accountLabel,
  onPage,
  quotaAccounts,
  accountsLoading,
  accountsError,
  accountRevision,
  quotaRefreshEpoch,
  onRefreshQuotas,
}: {
  activeView: ProviderUsageView;
  onViewChange: (view: ProviderUsageView) => void;
  snapshot: ProviderUsageSnapshot | null;
  lifetime: ProviderUsageSnapshot | null;
  overviewUnavailable: boolean;
  chartResetKey: string;
  providerLabel: (id: string) => string;
  accountLabel: (id: string | null) => string;
  onPage: (offset: number) => void;
  quotaAccounts: ProviderAccount[];
  accountsLoading: boolean;
  accountsError: boolean;
  accountRevision: number;
  quotaRefreshEpoch: number;
  onRefreshQuotas: () => void;
}) {
  const { intl } = useLCodeIntl();
  const m = (key: string) => intl.formatMessage({ id: `settings.oauthUsage.${key}` });
  const unavailable = overviewUnavailable ? (
    <p role="status" className="text-ui-sm text-foreground-subtle">
      {m("overviewUnavailable")}
    </p>
  ) : null;
  return (
    <Tabs
      value={activeView}
      onValueChange={(value) => onViewChange(value as ProviderUsageView)}
      className="min-w-0 gap-5"
    >
      <TabsList
        aria-label={m("views")}
        className={`${USAGE_STATS_TABS_LIST_CLASS} grid w-full grid-cols-3 sm:w-fit`}
      >
        {views.map((view) => (
          <TabsTrigger
            key={view}
            value={view}
            className={`${USAGE_STATS_TABS_TRIGGER_CLASS} min-w-0 whitespace-normal px-2 py-1`}
          >
            {m(`view.${view}`)}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value="charts" className="min-w-0 space-y-5">
        {lifetime && (
          <>
            <ProviderTokenActivity snapshot={lifetime} />
            <p className="text-ui-sm text-foreground-subtle">{m("activityScope")}</p>
          </>
        )}
        {unavailable}
        {snapshot &&
          (!snapshot.summary.requestCount ? (
            <p className="rounded-xl border border-dashed border-border p-6 text-center text-ui-sm text-foreground-subtle">
              {m("empty")}
            </p>
          ) : (
            <>
              <UsageChartLoadBoundary
                scope="oauth-usage"
                resetKeys={[snapshot.generatedAt, chartResetKey]}
                loadingDescription={m("loading")}
              >
                <ProviderUsageChart snapshot={snapshot} />
              </UsageChartLoadBoundary>
              <UsageChartLoadBoundary
                scope="oauth-model-usage"
                resetKeys={[snapshot.generatedAt, chartResetKey]}
                loadingDescription={m("loading")}
              >
                <ProviderModelUsageChart snapshot={snapshot} providerLabel={providerLabel} />
              </UsageChartLoadBoundary>
            </>
          ))}
      </TabsContent>
      <TabsContent value="statistics" className="min-w-0 space-y-5">
        <ProviderUsageOverview snapshot={lifetime} />
        {unavailable}
        {snapshot && (
          <>
            <ProviderUsageSummary summary={snapshot.summary} />
            {/* 原因：三表并排挤压长账号名称及数值列；独占整行才能在大字号下完整展示。 */}
            <div className="min-w-0 space-y-4">
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
          </>
        )}
      </TabsContent>
      {/* 原因：卸载额度卡会重新读取并丢失刷新中的状态；隐藏展示，保留原 hook 的唯一读取路径。 */}
      <TabsContent
        value="requests-quotas"
        forceMount
        className={`min-w-0 space-y-5${activeView === "requests-quotas" ? "" : " hidden"}`}
      >
        {snapshot && (
          <ProviderUsageRequests
            snapshot={snapshot}
            providerLabel={providerLabel}
            accountLabel={accountLabel}
            onPage={onPage}
          />
        )}
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
              onClick={onRefreshQuotas}
            >
              <RefreshCcw />
              {m("refreshQuotas")}
            </Button>
          </div>
          {accountsLoading && <p className="text-ui-sm text-foreground-subtle">{m("loading")}</p>}
          {accountsError && (
            <p role="status" className="text-ui-sm text-destructive">
              {m("accountsUnavailable")}
            </p>
          )}
          {!accountsLoading && !quotaAccounts.length && (
            <p className="text-ui-sm text-foreground-subtle">{m("noQuotaAccounts")}</p>
          )}
          <div className="grid gap-3 md:grid-cols-2">
            {quotaAccounts.map((account) => (
              <ProviderQuotaCard
                key={account.connectionId}
                account={account}
                providerName={providerLabel(`oauth:${account.channelId}`)}
                revision={accountRevision}
                refreshEpoch={quotaRefreshEpoch}
              />
            ))}
          </div>
        </section>
      </TabsContent>
    </Tabs>
  );
}
