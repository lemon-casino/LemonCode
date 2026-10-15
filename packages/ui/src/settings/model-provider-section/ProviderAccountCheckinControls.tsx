import type { ProviderAccount } from "@lcode/shared";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import type { useProviderAccounts } from "@/hooks/useProviderAccounts.js";

type Actions = ReturnType<typeof useProviderAccounts>;

export function ProviderAccountCheckinHeader({
  channelId,
  accounts,
  actions,
}: {
  channelId: string;
  accounts: readonly ProviderAccount[];
  actions: Actions;
}) {
  const { intl } = useLCodeIntl();
  const msg = (key: string) => intl.formatMessage({ id: `settings.oauth.checkin.${key}` });
  const busy = actions.busy !== null || accounts.some((account) => account.checkin?.running);
  return (
    <div className="flex flex-wrap items-center gap-3" data-testid="oauth-checkin-header">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={busy || !accounts.some((a) => a.enabled)}
        onClick={() => void actions.checkinAll(channelId)}
      >
        {msg("all")}
      </Button>
      <label className="flex items-center gap-2 text-ui-sm" title={msg("automaticHint")}>
        <Switch
          aria-label={msg("automatic")}
          disabled={busy || !accounts.length}
          checked={accounts.length > 0 && accounts.every((a) => a.checkin?.automatic)}
          onCheckedChange={(enabled) => void actions.setChannelAutomaticCheckin(channelId, enabled)}
        />
        {msg("automatic")}
      </label>
    </div>
  );
}

export function ProviderAccountCheckinButton({
  account,
  actions,
}: {
  account: ProviderAccount;
  actions: Actions;
}) {
  const { intl } = useLCodeIntl();
  const msg = (key: string) => intl.formatMessage({ id: `settings.oauth.checkin.${key}` });
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        data-testid={`oauth-checkin-${account.connectionId}`}
        disabled={actions.busy !== null || !account.enabled || account.checkin?.running}
        onClick={() => void actions.checkinAccount(account.connectionId)}
      >
        {msg(account.checkin?.running ? "running" : "one")}
      </Button>
      <label className="flex items-center gap-2 text-ui-sm" title={msg("automaticHint")}>
        <Switch
          disabled={actions.busy !== null}
          aria-label={intl.formatMessage(
            { id: "settings.oauth.checkin.automaticAccount" },
            { name: account.displayName },
          )}
          checked={account.checkin?.automatic ?? false}
          onCheckedChange={(enabled) =>
            void actions.setAutomaticCheckin(account.connectionId, enabled)
          }
        />
        {msg("automatic")}
      </label>
    </>
  );
}

export function ProviderAccountCheckinStatus({ account }: { account: ProviderAccount }) {
  const { intl, locale } = useLCodeIntl();
  const result = account.checkin?.result;
  if (!result && !account.checkin?.running) return null;
  const message = intl.formatMessage({
    id: `settings.oauth.checkin.${account.checkin?.running ? "running" : result!.outcome}`,
  });
  return (
    <p
      className="break-words text-ui-sm text-foreground-subtle"
      role="status"
      data-testid={`oauth-checkin-result-${account.connectionId}`}
    >
      {message}
      {result && !account.checkin?.running ? (
        <>
          {result.credit !== undefined
            ? ` · ${intl.formatMessage({ id: "settings.oauth.checkin.credit" }, { count: result.credit })}`
            : ""}
          {result.streak !== undefined
            ? ` · ${intl.formatMessage({ id: "settings.oauth.checkin.streak" }, { count: result.streak })}`
            : ""}
          {result.error
            ? ` · ${intl.formatMessage({ id: `settings.oauth.checkin.error.${result.error}` })}`
            : ""}
          {` · ${new Date(result.at).toLocaleString(locale)}`}
          {result.validUntil
            ? ` · ${intl.formatMessage({ id: "settings.oauth.checkin.validUntil" }, { time: new Date(result.validUntil).toLocaleString(locale) })}`
            : ""}
        </>
      ) : null}
    </p>
  );
}
