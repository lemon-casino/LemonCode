import type {
  ProviderUsageGroup,
  ProviderUsageMetrics,
  ProviderUsageSnapshot,
} from "@lcode/shared";
import { Button } from "@/components/ui/button.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { formatCompactNumber } from "./usageStatsUiParts.js";

export function ProviderUsageSummary({ summary }: { summary: ProviderUsageMetrics }) {
  const { intl, locale } = useLCodeIntl();
  const m = (key: string) => intl.formatMessage({ id: `settings.oauthUsage.${key}` });
  const n = (value: number) => new Intl.NumberFormat(locale).format(value);
  // 部分供应商写入字段长期为零或缺失；按用户要求取消该指标，读取和总量沿用原口径。
  const values: [string, string][] = [
    ["requests", n(summary.requestCount)],
    ["success", n(summary.successCount)],
    ["errors", n(summary.errorCount)],
    ["cancelled", n(summary.cancelledCount)],
    ["tokens", n(summary.totalTokens)],
    ["input", n(summary.inputTokens)],
    ["output", n(summary.outputTokens)],
    ["cacheRead", n(summary.cacheReadTokens)],
    ["reasoning", n(summary.reasoningTokens)],
    [
      "ttft",
      summary.avgTimeToFirstTokenMs === null
        ? m("unknown")
        : `${n(Math.round(summary.avgTimeToFirstTokenMs))} ms`,
    ],
    [
      "duration",
      summary.avgDurationMs === null ? m("unknown") : `${n(Math.round(summary.avgDurationMs))} ms`,
    ],
    ["retries", n(summary.retryCount)],
    [
      "cacheRate",
      summary.cacheHitRate === null
        ? m("unknown")
        : new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(
            summary.cacheHitRate,
          ),
    ],
  ];
  return (
    <section data-testid="oauth-usage-summary" aria-label={m("summary")}>
      <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {values.map(([key, value]) => (
          <div key={key} className="min-w-0 rounded-xl border border-border p-3">
            <dt className="text-ui-sm text-foreground-subtle">{m(key)}</dt>
            <dd className="mt-1 break-words font-mono text-ui-lg font-medium tabular-nums">
              {value}
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-ui-sm text-foreground-subtle">
        {intl.formatMessage(
          { id: "settings.oauthUsage.coverage" },
          { known: n(summary.knownUsageRequests), total: n(summary.requestCount) },
        )}
      </p>
    </section>
  );
}

export function ProviderUsageGroups({
  title,
  groups,
  label,
}: {
  title: string;
  groups: ProviderUsageGroup[];
  label: (group: ProviderUsageGroup) => string;
}) {
  const { intl, locale } = useLCodeIntl();
  const m = (key: string) => intl.formatMessage({ id: `settings.oauthUsage.${key}` });
  return (
    <section aria-label={title} className="min-w-0 space-y-3 rounded-xl border border-border p-4">
      <h3 className="text-ui-base font-medium">{title}</h3>
      {groups.length ? (
        <div className="overflow-x-auto">
          <table className="min-w-md w-full text-left text-ui-sm">
            <thead>
              <tr className="text-foreground-subtle">
                <th className="py-2 pr-4 font-normal">{m("name")}</th>
                <th className="whitespace-nowrap px-2 font-normal">{m("requests")}</th>
                <th className="whitespace-nowrap px-2 font-normal">{m("tokens")}</th>
                <th className="whitespace-nowrap px-2 font-normal">{m("errors")}</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => (
                <tr
                  key={[group.providerId, group.accountConnectionId, group.modelId].join(":")}
                  className="border-t border-border"
                >
                  {/* 长邮箱可在任意位置换行，避免表格的最小内容宽度撑破窄屏。 */}
                  <td className="w-full wrap-anywhere py-2 pr-4">{label(group)}</td>
                  <td className="whitespace-nowrap px-2 font-mono tabular-nums">
                    {group.requestCount}
                  </td>
                  <td className="whitespace-nowrap px-2 font-mono tabular-nums">
                    {group.knownUsageRequests
                      ? formatCompactNumber(locale, group.totalTokens)
                      : m("unknown")}
                  </td>
                  <td className="whitespace-nowrap px-2 font-mono tabular-nums">
                    {group.errorCount}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-ui-sm text-foreground-subtle">{m("empty")}</p>
      )}
    </section>
  );
}

export function ProviderUsageRequests({
  snapshot,
  accountLabel,
  providerLabel,
  onPage,
}: {
  snapshot: ProviderUsageSnapshot;
  accountLabel: (id: string | null) => string;
  providerLabel: (id: string) => string;
  onPage: (offset: number) => void;
}) {
  const { intl, locale } = useLCodeIntl();
  const m = (key: string) => intl.formatMessage({ id: `settings.oauthUsage.${key}` });
  return (
    <section
      aria-label={m("recent")}
      className="min-w-0 space-y-3 rounded-xl border border-border p-4"
    >
      <h3 className="text-ui-base font-medium">{m("recent")}</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-ui-sm">
          <thead>
            <tr className="text-foreground-subtle">
              {["time", "provider", "account", "model", "status", "tokens", "duration"].map(
                (key) => (
                  <th key={key} className="whitespace-nowrap px-2 py-2 font-normal first:pl-0">
                    {m(key)}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {snapshot.requests.map((request) => (
              <tr className="border-t border-border" key={request.id}>
                <td className="whitespace-nowrap py-2 pr-2">
                  {new Date(request.startedAt).toLocaleString(locale)}
                </td>
                <td className="max-w-40 break-words px-2">{providerLabel(request.providerId)}</td>
                <td className="max-w-40 break-words px-2">
                  {accountLabel(request.accountConnectionId)}
                </td>
                <td className="max-w-40 break-words px-2">{request.modelId}</td>
                <td className="whitespace-nowrap px-2">{m(`status.${request.status}`)}</td>
                <td className="px-2 font-mono tabular-nums">
                  {request.totalTokens === null
                    ? m("unknown")
                    : formatCompactNumber(locale, request.totalTokens)}
                </td>
                <td className="whitespace-nowrap px-2 font-mono tabular-nums">
                  {request.durationMs === null
                    ? m("unknown")
                    : `${Math.round(request.durationMs)} ms`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!snapshot.requests.length ? (
        <p className="text-ui-sm text-foreground-subtle">{m("empty")}</p>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2 text-ui-sm">
        <span>
          {intl.formatMessage(
            { id: "settings.oauthUsage.page" },
            {
              start: snapshot.totalRequests ? snapshot.offset + 1 : 0,
              end: Math.min(snapshot.offset + snapshot.requests.length, snapshot.totalRequests),
              total: snapshot.totalRequests,
            },
          )}
        </span>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={snapshot.offset === 0}
            onClick={() => onPage(Math.max(0, snapshot.offset - snapshot.limit))}
          >
            {m("previous")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={snapshot.offset + snapshot.limit >= snapshot.totalRequests}
            onClick={() => onPage(snapshot.offset + snapshot.limit)}
          >
            {m("next")}
          </Button>
        </div>
      </div>
    </section>
  );
}
