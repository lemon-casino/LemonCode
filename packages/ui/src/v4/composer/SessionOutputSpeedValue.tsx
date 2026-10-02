import type { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { formatCompactTokenNumber } from "@/lib/tokenNumberFormat.js";
import type { SessionOutputSpeed } from "./sessionOutputSpeed.js";

/** Composer、只读子面板和统计明细共享标签，均速不能冒充当前请求实时速度。 */
export function SessionOutputSpeedValue({
  speed,
  intl,
  locale,
  compact = false,
}: {
  speed: SessionOutputSpeed;
  intl: ReturnType<typeof useLCodeIntl>["intl"];
  locale: string;
  compact?: boolean;
}) {
  const rate = speed.liveRate ?? speed.average?.rate ?? null;
  const kind = speed.liveRate !== null ? "live" : "average";
  const label = intl.formatMessage({
    id: kind === "live" ? "chat.sessionUsage.speed" : "chat.sessionUsage.averageSpeed",
  });
  const pendingLabel = intl.formatMessage({ id: "chat.sessionUsage.speedPending" });
  if (rate === null && !speed.pending) return null;
  const title = [rate === null ? null : label, speed.pending ? pendingLabel : null]
    .filter(Boolean)
    .join("；");
  return (
    <span
      className="inline-flex max-w-full flex-wrap items-center gap-x-2 gap-y-1 text-ui-xs"
      title={title}
    >
      {rate === null ? null : (
        <span
          data-testid="session-output-speed"
          data-speed-kind={kind}
          aria-label={`${label} ${rate} token/s`}
        >
          {compact
            ? kind === "average"
              ? `${intl.formatMessage({ id: "chat.sessionUsage.averageShort" })} `
              : null
            : `${label} `}
          <strong className="font-mono font-medium tabular-nums text-foreground">
            {formatCompactTokenNumber(locale, rate)}
            {compact ? "/s" : " token/s"}
          </strong>
        </span>
      )}
      {speed.pending && (!compact || rate === null) ? (
        <span
          data-testid="session-output-speed-pending"
          className="font-sans text-foreground-subtle"
        >
          {compact
            ? intl.formatMessage({ id: "chat.sessionUsage.speedPendingShort" })
            : pendingLabel}
        </span>
      ) : null}
    </span>
  );
}
