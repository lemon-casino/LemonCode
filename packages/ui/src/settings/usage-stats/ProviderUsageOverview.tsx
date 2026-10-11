import type { ProviderUsageSnapshot } from "@lcode/shared";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { formatAppUsageDuration } from "./AppUsagePanel.js";
import { formatCompactNumber, formatSummaryCompactTokenUsage } from "./usageStatsUiParts.js";
import { ProviderTokenActivity } from "./ProviderTokenActivity.js";

export function ProviderUsageOverview({ snapshot }: { snapshot: ProviderUsageSnapshot | null }) {
  const { intl, locale } = useLCodeIntl();
  const activity = snapshot?.activity;
  const unknown = intl.formatMessage({ id: "settings.oauthUsage.unknown" });
  const token = (value: number | undefined) =>
    value === undefined
      ? "--"
      : snapshot!.summary.requestCount && !snapshot!.summary.knownUsageRequests
        ? unknown
        : formatSummaryCompactTokenUsage(locale, value);
  const days = (value: number | undefined) =>
    value === undefined
      ? "--"
      : `${formatCompactNumber(locale, value)} ${intl.formatMessage({ id: "settings.usage.duration.day" })}`;
  const items: [string, string][] = [
    ["settings.oauthUsage.lifetimeTokens", token(snapshot?.summary.totalTokens)],
    ["settings.usage.lifetimePeakTokens", token(activity?.peakDayTokens)],
    [
      "settings.usage.longestSession",
      activity === undefined
        ? "--"
        : activity.longestSessionMs === null
          ? unknown
          : formatAppUsageDuration(activity.longestSessionMs, intl),
    ],
    ["settings.usage.currentStreak", days(activity?.currentStreakDays)],
    ["settings.usage.longestStreak", days(activity?.longestStreakDays)],
  ];
  return (
    <section className="space-y-3" data-testid="oauth-lifetime-summary">
      <dl className="grid overflow-hidden rounded-xl bg-surface sm:grid-cols-5">
        {items.map(([id, value]) => (
          <div key={id} className="flex min-w-0 flex-col px-3 py-3 text-center">
            <dt className="order-2 mt-1 text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id })}
            </dt>
            <dd className="order-1 break-words text-ui-lg font-medium tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: "settings.oauthUsage.lifetimeScope" })}
      </p>
      {snapshot && <ProviderTokenActivity snapshot={snapshot} />}
    </section>
  );
}
