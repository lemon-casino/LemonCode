import { RefreshCcw } from "lucide-react";
import type { ProviderAccount, ProviderAccountQuotaWindow } from "@lcode/shared";
import { Button } from "@/components/ui/button.js";
import { Progress } from "@/components/ui/progress.js";
import { useProviderAccountQuota } from "@/hooks/useProviderUsageStats.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";

export function ProviderQuotaCard({
  account,
  providerName,
  revision,
  refreshEpoch,
}: {
  account: ProviderAccount;
  providerName: string;
  revision: number;
  refreshEpoch: number;
}) {
  const { intl, locale } = useLCodeIntl();
  const { quota, loading, error, refresh } = useProviderAccountQuota(
    account.connectionId,
    revision,
    refreshEpoch,
  );
  const message = (key: string) => intl.formatMessage({ id: `settings.oauthUsage.${key}` });
  // 同名账号可同时属于不同供应商；额度卡必须展示两层身份，避免全部供应商视图无法区分。
  const title = `${providerName} · ${account.displayName}`;
  return (
    <section
      className="min-w-0 space-y-3 rounded-xl border border-border p-4"
      data-testid={`quota-${account.connectionId}`}
      aria-label={title}
    >
      <div className="flex items-center justify-between gap-2">
        <h4 className="min-w-0 truncate text-ui-base font-medium" title={title}>
          {title}
        </h4>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={loading}
          onClick={refresh}
          aria-label={message("refreshQuota")}
        >
          <RefreshCcw className={loading ? "animate-spin" : ""} />
        </Button>
      </div>
      {loading && !quota ? (
        <p className="text-ui-sm text-foreground-subtle">{message("loading")}</p>
      ) : null}
      {error || quota?.status === "error" ? (
        <p role="status" className="text-ui-sm text-destructive">
          {message("quota.error")}
        </p>
      ) : null}
      {quota && quota.status !== "ready" && quota.status !== "error" ? (
        <p className="text-ui-sm text-foreground-subtle">{message(`quota.${quota.status}`)}</p>
      ) : null}
      {quota?.plan ? <p className="break-words text-ui-sm">{quota.plan}</p> : null}
      {quota?.balance ? (
        <p className="break-words text-ui-sm">
          {message("balance")}: {quota.balance}
        </p>
      ) : null}
      {quota?.planExpiresAt ? (
        <p className="text-ui-xs text-foreground-subtle">
          {message("planExpiresAt")} {new Date(quota.planExpiresAt).toLocaleString(locale)}
        </p>
      ) : null}
      {quota?.renewal ? (
        <p className="text-ui-xs text-foreground-subtle">
          {message("renewal")}: {message(`renewal.${quota.renewal}`)}
        </p>
      ) : null}
      {quota?.stale ? (
        <p className="text-ui-sm text-foreground-subtle">{message("stale")}</p>
      ) : null}
      {quota?.partial ? (
        <p role="status" className="text-ui-sm text-foreground-subtle">
          {message("partial")}
        </p>
      ) : null}
      {quota?.windows.map((window) => (
        <QuotaWindow key={window.id} window={window} />
      ))}
      {quota?.status === "ready" && !quota.windows.length && !quota.balance ? (
        <p className="text-ui-sm text-foreground-subtle">{message("quota.unknown")}</p>
      ) : null}
      {quota?.checkedAt ? (
        <p className="text-ui-xs text-foreground-subtle">
          {message("checkedAt")} {new Date(quota.checkedAt).toLocaleString(locale)}
        </p>
      ) : null}
    </section>
  );
}

function QuotaWindow({ window }: { window: ProviderAccountQuotaWindow }) {
  const { intl, locale } = useLCodeIntl();
  const message = (key: string) => intl.formatMessage({ id: `settings.oauthUsage.${key}` });
  const numberFormat = new Intl.NumberFormat(locale, { maximumFractionDigits: 6 });
  const number = (value: number) => numberFormat.format(value);
  const remaining =
    window.remainingPercent ?? (window.usedPercent === undefined ? null : 100 - window.usedPercent);
  const counts = (["used", "remaining", "limit"] as const).flatMap((key) =>
    window[key] === undefined ? [] : [{ key, value: window[key] }],
  );
  const hasReading = window.unlimited || remaining !== null || window.display || counts.length;
  return (
    <div className="min-w-0 space-y-1.5 [overflow-wrap:anywhere]">
      <div className="flex flex-wrap justify-between gap-x-3 gap-y-1 text-ui-sm">
        <span className="font-medium">{window.name}</span>
        {window.unlimited ? <span>{message("unlimited")}</span> : null}
        {remaining !== null && !window.unlimited ? (
          <span>
            {message("remaining")}{" "}
            <span className="font-mono tabular-nums">{number(remaining)}%</span>
          </span>
        ) : null}
      </div>
      {window.pool ? (
        <p className="text-ui-xs text-foreground-subtle">
          {message("pool")}: {window.pool}
        </p>
      ) : null}
      {window.modelId ? (
        <p className="text-ui-xs text-foreground-subtle">
          {message("model")}: {window.modelId}
        </p>
      ) : null}
      {remaining !== null && !window.unlimited ? <Progress value={remaining} /> : null}
      {window.usedPercent !== undefined ? (
        <p className="text-ui-xs text-foreground-subtle">
          {message("used")} {number(window.usedPercent)}%
        </p>
      ) : null}
      {/* 厂商金额/说明和百分比是互补事实，不能因为存在进度条就隐藏原始可读额度。 */}
      {window.display ? <p className="text-ui-sm">{window.display}</p> : null}
      {counts.length ? (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-ui-xs sm:grid-cols-3">
          {counts.map(({ key, value }) => (
            <div className="min-w-0" key={key}>
              <dt className="text-foreground-subtle">{message(key)}</dt>
              <dd className="font-mono tabular-nums">
                {number(value)}
                {window.unit ? ` ${window.unit}` : ""}
              </dd>
            </div>
          ))}
        </dl>
      ) : window.unit ? (
        <p className="text-ui-xs text-foreground-subtle">
          {message("unit")}: {window.unit}
        </p>
      ) : null}
      {!hasReading ? (
        <p className="text-ui-sm text-foreground-subtle">{message("unknown")}</p>
      ) : null}
      {window.resetAt ? (
        <p className="text-ui-xs text-foreground-subtle">
          {message("resets")} {new Date(window.resetAt).toLocaleString(locale)}
        </p>
      ) : null}
      {window.expiresAt ? (
        <p className="text-ui-xs text-foreground-subtle">
          {message("expiresAt")} {new Date(window.expiresAt).toLocaleString(locale)}
        </p>
      ) : null}
    </div>
  );
}
