import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import type { ProviderUsageSnapshot } from "@lcode/shared";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { formatCompactNumber, formatDay } from "./usageStatsUiParts.js";

export function ProviderUsageChart({ snapshot }: { snapshot: ProviderUsageSnapshot }) {
  const { intl, locale } = useLCodeIntl();
  const title = intl.formatMessage({ id: "settings.oauthUsage.daily" });
  return (
    <section aria-label={title} className="min-w-0 rounded-xl border border-border p-4">
      <h3 className="mb-4 text-ui-base font-medium">{title}</h3>
      <ChartContainer
        className="h-56 w-full"
        config={{
          totalTokens: {
            label: intl.formatMessage({ id: "settings.oauthUsage.tokens" }),
            color: "var(--color-usage-chart-2)",
          },
        }}
      >
        <LineChart
          accessibilityLayer
          data={snapshot.daily.map((day) => ({
            ...day,
            totalTokens:
              day.requestCount > 0 && day.knownUsageRequests === 0 ? null : day.totalTokens,
          }))}
          margin={{ top: 8, right: 12, bottom: 0, left: 0 }}
        >
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="date"
            tickFormatter={(date) => formatDay(locale, String(date))}
            minTickGap={30}
          />
          <YAxis width={48} tickFormatter={(value) => formatCompactNumber(locale, Number(value))} />
          <ChartTooltip content={<ChartTooltipContent />} />
          <Line
            type="linear"
            dataKey="totalTokens"
            stroke="var(--color-totalTokens)"
            strokeWidth={2}
            dot={snapshot.daily.length < 8}
            isAnimationActive={false}
          />
        </LineChart>
      </ChartContainer>
    </section>
  );
}
