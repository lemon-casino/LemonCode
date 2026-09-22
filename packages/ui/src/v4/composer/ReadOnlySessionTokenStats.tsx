import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatCompactTokenNumber } from "@/lib/tokenNumberFormat.js";
import { readChildSessionTokenTotal, readLiveOutputObservation } from "./sessionTokenStats.js";
import { useLiveOutputRate } from "./useLiveOutputRate.js";

export function ReadOnlySessionTokenStats({ snapshot }: { snapshot: ConversationSnapshot }) {
  const { intl, locale } = useZCodeIntl();
  const rate = useLiveOutputRate(snapshot);
  const currentOutput = readLiveOutputObservation(snapshot)?.sample.estimatedTokens ?? null;
  const total = readChildSessionTokenTotal(snapshot);
  return (
    <div
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-1.5 text-ui-xs text-foreground-subtle"
      data-testid="read-only-session-token-stats"
    >
      {total === null ? (
        <span>{intl.formatMessage({ id: "chat.sessionUsage.unavailable" })}</span>
      ) : (
        <span
          title={intl.formatMessage(
            { id: "chat.sessionUsage.summary" },
            { total: new Intl.NumberFormat(locale).format(total) },
          )}
        >
          {intl.formatMessage({ id: "chat.sessionUsage.title" })}{" "}
          <strong className="font-mono font-medium tabular-nums text-foreground">
            {formatCompactTokenNumber(locale, total)}
          </strong>
        </span>
      )}
      {currentOutput === null ? null : (
        <span title={intl.formatMessage({ id: "chat.sessionUsage.currentOutput" })}>
          {intl.formatMessage({ id: "chat.sessionUsage.currentOutput" })}{" "}
          <strong className="font-mono font-medium tabular-nums text-foreground">
            {formatCompactTokenNumber(locale, currentOutput)}
          </strong>
        </span>
      )}
      {rate === null ? null : (
        <span title={intl.formatMessage({ id: "chat.sessionUsage.speed" })}>
          {intl.formatMessage({ id: "chat.sessionUsage.speed" })}{" "}
          <strong className="font-mono font-medium tabular-nums text-foreground">
            {formatCompactTokenNumber(locale, rate)} token/s
          </strong>
        </span>
      )}
    </div>
  );
}
