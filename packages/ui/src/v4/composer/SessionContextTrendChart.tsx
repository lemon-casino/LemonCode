import { CartesianGrid, Legend, Line, LineChart, ReferenceDot, XAxis, YAxis } from "recharts";
import type { SessionUsageState } from "@lcode/shared/lcode-protocol-v4";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { formatCompactTokenNumber } from "@/lib/tokenNumberFormat.js";

export function SessionContextTrendChart({
  trend,
}: {
  trend: NonNullable<SessionUsageState["contextTrend"]>;
}) {
  const { intl, locale } = useLCodeIntl();
  const data = trend.samples.map((sample, index) => ({ ...sample, index }));
  const used = intl.formatMessage({ id: "chat.contextTrend.used" });
  const capacity = intl.formatMessage({ id: "chat.contextTrend.capacity" });
  return (
    <ChartContainer
      className="h-56 min-w-0 w-full max-w-full"
      config={{
        usedTokens: { label: used, color: "var(--color-usage-chart-2)" },
        maxTokens: { label: capacity, color: "var(--color-usage-chart-3)" },
      }}
    >
      <LineChart accessibilityLayer data={data} margin={{ top: 12, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid vertical={false} />
        <Legend
          content={
            <div className="flex flex-wrap justify-center gap-x-4 gap-y-1 pt-2 text-ui-xs text-foreground-subtle">
              <span className="inline-flex items-center gap-1.5">
                <span
                  className="w-4 border-t-2"
                  style={{ borderColor: "var(--color-usage-chart-2)" }}
                />
                {used}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span
                  className="w-4 border-t-2 border-dashed"
                  style={{ borderColor: "var(--color-usage-chart-3)" }}
                />
                {capacity}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span
                  className="size-2 rounded-full"
                  style={{ backgroundColor: "var(--color-usage-chart-4)" }}
                />
                {intl.formatMessage({ id: "chat.contextTrend.compact" })}
              </span>
            </div>
          }
        />
        <XAxis
          dataKey="index"
          minTickGap={45}
          tickFormatter={(index) => {
            const sample = data[Number(index)];
            return sample
              ? new Date(sample.timestamp).toLocaleTimeString(locale, {
                  hour: "2-digit",
                  minute: "2-digit",
                })
              : "";
          }}
        />
        <YAxis
          width={50}
          tickFormatter={(value) => formatCompactTokenNumber(locale, Number(value))}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(_, payload) =>
                payload?.[0]?.payload?.timestamp
                  ? new Date(payload[0].payload.timestamp as number).toLocaleString(locale)
                  : ""
              }
            />
          }
        />
        <Line
          type="linear"
          dataKey="usedTokens"
          stroke="var(--color-usedTokens)"
          strokeWidth={2}
          dot={false}
          isAnimationActive={false}
        />
        <Line
          type="stepAfter"
          dataKey="maxTokens"
          stroke="var(--color-maxTokens)"
          strokeDasharray="4 4"
          dot={{ r: 3 }}
          connectNulls={false}
          isAnimationActive={false}
        />
        {data
          .filter((sample) => sample.kind === "compact")
          .map((sample) => (
            <ReferenceDot
              key={sample.id}
              x={sample.index}
              y={sample.usedTokens}
              r={4}
              fill="var(--color-usage-chart-4)"
              stroke="none"
            />
          ))}
      </LineChart>
    </ChartContainer>
  );
}
