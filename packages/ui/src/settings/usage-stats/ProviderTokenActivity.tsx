import { useState } from "react";
import type { ProviderUsageSnapshot } from "@lcode/shared";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs.js";
import {
  HeatmapColumn,
  type HeatmapDisplayColumn,
  type TokenActivityMode,
} from "./UsageHeatmapCells.js";
import {
  USAGE_STATS_TABS_LIST_CLASS,
  USAGE_STATS_TABS_TRIGGER_CLASS,
  formatCompactNumber,
  formatFullDay,
  formatMonth,
} from "./usageStatsUiParts.js";

const WEEK_DAYS = 7;
const MAX_WEEKS = 54;
const DISPLAY_WEEKS = 52;
const DAY_MS = 86_400_000;
const modes = ["daily", "weekly", "cumulative"] as const;
type Day = ProviderUsageSnapshot["daily"][number];
type Value = { tokens: number; requests: number; known: number };
const value = (days: readonly Day[]): Value =>
  days.reduce(
    (sum, day) => ({
      tokens: sum.tokens + day.totalTokens,
      requests: sum.requests + day.requestCount,
      known: sum.known + day.knownUsageRequests,
    }),
    { tokens: 0, requests: 0, known: 0 },
  );
const dayIndex = (date: string) => Math.floor(Date.parse(`${date}T00:00:00Z`) / DAY_MS);

export function ProviderTokenActivity({ snapshot }: { snapshot: ProviderUsageSnapshot }) {
  const { intl, locale } = useLCodeIntl();
  const [mode, setMode] = useState<TokenActivityMode>("daily");
  const { daily } = snapshot;
  const first = daily[0];
  if (!first) return null;
  const firstIndex = dayIndex(first.date);
  const firstWeek = firstIndex - new Date(firstIndex * DAY_MS).getUTCDay();
  const lastIndex = dayIndex(daily.at(-1)!.date);
  const count = Math.min(MAX_WEEKS, Math.ceil((lastIndex - firstWeek + 1) / WEEK_DAYS));
  const weeks = Array.from({ length: count }, (_, week) =>
    daily.filter((day) => Math.floor((dayIndex(day.date) - firstWeek) / WEEK_DAYS) === week),
  );
  const byDate = new Map(daily.map((day) => [day.date, day]));
  const sums = weeks.map((week, i) =>
    value(mode === "cumulative" ? weeks.slice(0, i + 1).flat() : week),
  );
  const max =
    mode === "daily"
      ? Math.max(...daily.map((day) => day.totalTokens))
      : Math.max(...sums.map((sum) => sum.tokens));
  const tokens = (entry: Value) =>
    entry.requests && !entry.known
      ? intl.formatMessage({ id: "settings.oauthUsage.unknown" })
      : formatCompactNumber(locale, entry.tokens);
  const title = (date: string, entry: Value) =>
    intl.formatMessage(
      { id: `settings.oauthUsage.activity.${mode}` },
      {
        date: formatFullDay(locale, date),
        tokens: tokens(entry),
        requests: entry.requests,
        known: entry.known,
      },
    );
  const level = (entry: Value) =>
    Math.min(
      4,
      entry.tokens > 0 && max > 0 ? Math.max(1, Math.ceil((entry.tokens / max) * 4)) : 0,
    ) as 0 | 1 | 2 | 3 | 4;
  const columns: HeatmapDisplayColumn[] = weeks.map((week, i) => ({
    key: String(i),
    monthDate: week[0]?.date ?? first.date,
    tooltipTitle: mode === "daily" ? null : title(week.at(-1)?.date ?? first.date, sums[i]!),
    cells: Array.from({ length: WEEK_DAYS }, (_, day) => {
      const date = new Date((firstWeek + i * WEEK_DAYS + day) * DAY_MS).toISOString().slice(0, 10);
      const observed = byDate.get(date);
      const sum = mode === "daily" ? value(observed ? [observed] : []) : sums[i]!;
      return {
        key: date,
        tooltipTitle: observed && mode === "daily" ? title(date, sum) : undefined,
        level: mode === "daily" || observed ? level(sum) : 0,
        hasUsage: !!observed && sum.requests > 0,
        columnHover: mode !== "daily",
      };
    }),
  }));
  // 与API保持紧凑周网格；保留区之外只是无日期/无提示的空位，不能冒充零消耗记录。
  const displayColumns: HeatmapDisplayColumn[] = [
    ...Array.from({ length: Math.max(0, DISPLAY_WEEKS - columns.length) }, (_, week) => ({
      key: `empty-${week}`,
      monthDate: "",
      tooltipTitle: null,
      cells: Array.from({ length: WEEK_DAYS }, (_, day) => ({
        key: `empty-${week}-${day}`,
        level: 0 as const,
        hasUsage: false,
        columnHover: false,
      })),
    })),
    ...columns,
  ];
  const months: { date: string; span: number }[] = [];
  for (const column of displayColumns) {
    const last = months.at(-1);
    if (last && last.date.slice(0, 7) === column.monthDate.slice(0, 7)) last.span++;
    else months.push({ date: column.monthDate, span: 1 });
  }
  const gridStyle = { gridTemplateColumns: `repeat(${displayColumns.length}, minmax(0, 1fr))` };
  return (
    <section
      className="min-w-0 space-y-3 rounded-xl border border-border p-4"
      data-testid="oauth-token-activity"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-ui-base font-medium">
          {intl.formatMessage({ id: "settings.usage.heatmapTitle" })}
        </h3>
        <Tabs value={mode} onValueChange={(next) => setMode(next as TokenActivityMode)}>
          <TabsList className={USAGE_STATS_TABS_LIST_CLASS}>
            {modes.map((entry) => (
              <TabsTrigger key={entry} value={entry} className={USAGE_STATS_TABS_TRIGGER_CLASS}>
                {intl.formatMessage({ id: `settings.usage.heatmap.range.${entry}` })}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>
      <div className="grid gap-1 text-ui-xs text-foreground-subtle" style={gridStyle}>
        {months.map((month, i) => (
          <div key={i} className="truncate" style={{ gridColumn: `span ${month.span}` }}>
            {month.date ? formatMonth(locale, month.date) : ""}
          </div>
        ))}
      </div>
      <div className="grid gap-1" style={gridStyle} data-testid={`oauth-activity-${mode}`}>
        {displayColumns.map((column) => (
          <div key={column.key} className="min-w-0">
            <HeatmapColumn column={column} mode={mode} />
          </div>
        ))}
      </div>
      <details className="text-ui-sm">
        <summary className="cursor-pointer text-foreground-subtle">
          {intl.formatMessage({ id: "settings.oauthUsage.activityDetails" })}
        </summary>
        <div className="max-h-52 overflow-auto">
          <table className="w-full text-left">
            <thead>
              <tr>
                {["time", "tokens", "requests", "coverageTitle"].map((key) => (
                  <th key={key} className="py-2 pr-3 font-normal">
                    {intl.formatMessage({ id: `settings.oauthUsage.${key}` })}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {daily.map((day) => (
                <tr key={day.date}>
                  <td className="py-1 pr-3 whitespace-nowrap">{formatFullDay(locale, day.date)}</td>
                  <td className="pr-3">{tokens(value([day]))}</td>
                  <td className="pr-3">{day.requestCount}</td>
                  <td>
                    {day.knownUsageRequests} / {day.requestCount}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      {snapshot.activity?.dailyTruncated && (
        <p className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "settings.oauthUsage.activityTruncated" })}
        </p>
      )}
    </section>
  );
}
