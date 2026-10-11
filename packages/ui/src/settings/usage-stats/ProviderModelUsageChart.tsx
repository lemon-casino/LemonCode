import { Area, AreaChart, CartesianGrid, Cell, Pie, PieChart, XAxis, YAxis } from "recharts";
import type { ProviderUsageSnapshot } from "@lcode/shared";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { formatCompactNumber, formatDay } from "./usageStatsUiParts.js";

const COLORS = Array.from({ length: 5 }, (_, i) => `var(--color-usage-chart-${i + 1})`);
const identity = (provider: string, model: string | null) => JSON.stringify([provider, model]);

export function ProviderModelUsageChart({
  snapshot,
  providerLabel,
}: {
  snapshot: ProviderUsageSnapshot;
  providerLabel: (id: string) => string;
}) {
  const { intl, locale } = useLCodeIntl();
  const m = (key: string) => intl.formatMessage({ id: `settings.oauthUsage.${key}` });
  const models = snapshot.models.map((group, index) => ({
    ...group,
    key: `model-${index}`,
    identity: identity(group.providerId, group.modelId),
    label: `${providerLabel(group.providerId)} · ${group.modelId ?? m("unknown")}`,
    color: COLORS[index % COLORS.length]!,
  }));
  const config = Object.fromEntries(
    models.map((model) => [model.key, { label: model.label, color: model.color }]),
  );
  const byDay = new Map(
    snapshot.dailyModels?.map((day) => [
      `${day.date}:${identity(day.providerId, day.modelId)}`,
      day,
    ]),
  );
  const days = snapshot.daily.map((day) => ({
    date: day.date,
    ...Object.fromEntries(
      models.map((model) => {
        const entry = byDay.get(`${day.date}:${model.identity}`);
        return [
          model.key,
          entry && entry.requestCount > 0 && entry.knownUsageRequests === 0
            ? null
            : (entry?.totalTokens ?? 0),
        ];
      }),
    ),
  }));
  const pie = models.filter((model) => model.knownUsageRequests > 0 && model.totalTokens > 0);
  return (
    <div className="grid min-w-0 gap-4 xl:grid-cols-2" data-testid="oauth-model-usage">
      <section className="min-w-0 rounded-xl border border-border p-4">
        <h3 className="mb-4 text-ui-base font-medium">{m("modelTrend")}</h3>
        {snapshot.dailyModels === undefined ? (
          <p className="text-ui-sm text-foreground-subtle">{m("overviewUnavailable")}</p>
        ) : (
          <ChartContainer config={config} className="h-56 w-full">
            <AreaChart
              accessibilityLayer
              data={days}
              margin={{ top: 8, right: 12, bottom: 0, left: 0 }}
            >
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="date"
                tickFormatter={(date) => formatDay(locale, String(date))}
                minTickGap={30}
              />
              <YAxis
                width={48}
                tickFormatter={(tokens) => formatCompactNumber(locale, Number(tokens))}
              />
              <ChartTooltip content={<ChartTooltipContent />} />
              {models.map((model) => (
                <Area
                  key={model.key}
                  type="linear"
                  dataKey={model.key}
                  stackId="tokens"
                  stroke={model.color}
                  fill={model.color}
                  fillOpacity={0.3}
                  isAnimationActive={false}
                />
              ))}
            </AreaChart>
          </ChartContainer>
        )}
      </section>
      <section className="min-w-0 rounded-xl border border-border p-4">
        <h3 className="text-ui-base font-medium">{m("modelDistribution")}</h3>
        <p className="mt-1 text-ui-sm text-foreground-subtle">{m("modelKnownOnly")}</p>
        {pie.length ? (
          <>
            <ChartContainer config={config} className="h-56 w-full">
              <PieChart accessibilityLayer>
                <ChartTooltip content={<ChartTooltipContent nameKey="label" />} />
                <Pie
                  data={pie}
                  dataKey="totalTokens"
                  nameKey="label"
                  innerRadius={45}
                  outerRadius={80}
                  isAnimationActive={false}
                >
                  {pie.map((model) => (
                    <Cell key={model.key} fill={model.color} />
                  ))}
                </Pie>
              </PieChart>
            </ChartContainer>
            <ul className="space-y-1 text-ui-sm">
              {pie.map((model) => (
                <li key={model.key} className="flex min-w-0 items-start gap-2">
                  <span
                    aria-hidden
                    className="mt-1 size-2 shrink-0 rounded-full"
                    style={{ backgroundColor: model.color }}
                  />
                  <span className="min-w-0 flex-1 break-words">{model.label}</span>
                  <span className="shrink-0 tabular-nums">
                    {formatCompactNumber(locale, model.totalTokens)}
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="py-10 text-center text-ui-sm text-foreground-subtle">
            {m("noKnownModelUsage")}
          </p>
        )}
      </section>
    </div>
  );
}
