import { lazy, useState } from "react";
import { ChartNoAxesCombined } from "lucide-react";
import type { SessionUsageState } from "@lcode/shared/lcode-protocol-v4";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { UsageChartLoadBoundary } from "@/settings/usage-stats/UsageChartLoadBoundary.js";

const Chart = lazy(() =>
  import("./SessionContextTrendChart.js").then((module) => ({
    default: module.SessionContextTrendChart,
  })),
);
type Trend = SessionUsageState["contextTrend"];

export function SessionContextTrendContent({
  trend,
  onCloseAutoFocus,
}: {
  trend: Trend;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const { intl, locale } = useLCodeIntl();
  const m = (key: string) => intl.formatMessage({ id: `chat.contextTrend.${key}` });
  const n = (value: number) => new Intl.NumberFormat(locale).format(value);
  return (
    // grid 默认 min-content 轨道会被图表/表格撑宽；显式零最小轨道使手机弹层正文和图表按可用宽度布局。
    <DialogContent className="w-[48rem] grid-cols-1" onCloseAutoFocus={onCloseAutoFocus}>
      <DialogHeader className="pr-8">
        <DialogTitle>{m("title")}</DialogTitle>
        <DialogDescription>{m("description")}</DialogDescription>
      </DialogHeader>
      {!trend?.samples.length ? (
        <p className="py-8 text-center text-ui-sm text-foreground-subtle">{m("empty")}</p>
      ) : (
        <>
          <UsageChartLoadBoundary
            scope="session-context-trend"
            resetKeys={[trend.samples]}
            loadingDescription={m("loading")}
          >
            <Chart trend={trend} />
          </UsageChartLoadBoundary>
          {trend.truncated ? (
            <p className="text-ui-sm text-foreground-subtle">{m("truncated")}</p>
          ) : null}
          <div className="max-h-60 min-w-0 max-w-full overflow-auto">
            <table className="w-full text-left text-ui-sm">
              <thead>
                <tr className="text-foreground-subtle">
                  {["time", "event", "model", "used", "capacity"].map((key) => (
                    <th key={key} className="whitespace-nowrap px-2 py-2 font-normal first:pl-0">
                      {m(key)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {trend.samples.map((sample) => (
                  <tr key={sample.id} className="border-t border-border">
                    <td className="whitespace-nowrap py-2 pr-2">
                      {new Date(sample.timestamp).toLocaleTimeString(locale)}
                    </td>
                    <td className="whitespace-nowrap px-2">
                      {m(sample.kind)}
                      {sample.kind === "compact" && sample.tokensBefore !== undefined
                        ? ` (${n(sample.tokensBefore)} → ${n(sample.usedTokens)})`
                        : ""}
                    </td>
                    <td className="max-w-48 break-words px-2">{sample.modelId ?? m("unknown")}</td>
                    <td className="px-2 font-mono tabular-nums">{n(sample.usedTokens)}</td>
                    <td className="px-2 font-mono tabular-nums">
                      {sample.maxTokens === null ? m("unknown") : n(sample.maxTokens)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </DialogContent>
  );
}

export function SessionContextTrend({ trend }: { trend: Trend }) {
  const { intl } = useLCodeIntl();
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" className="h-6 px-1 text-ui-xs">
          <ChartNoAxesCombined />
          {intl.formatMessage({ id: "chat.contextTrend.title" })}
        </Button>
      </DialogTrigger>
      {open ? <SessionContextTrendContent trend={trend} /> : null}
    </Dialog>
  );
}
