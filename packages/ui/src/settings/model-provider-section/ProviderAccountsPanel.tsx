import type { ProviderAccount } from "@lcode/shared";
import { useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { useProviderAccounts } from "@/hooks/useProviderAccounts.js";
import { getProviderAccountDependencyError } from "@/lib/providerAccountErrors.js";
import { ProviderAuthorizationForm } from "./ProviderAuthorizationForm.js";
import { ProviderQuotaCard } from "@/settings/usage-stats/ProviderQuotaCard.js";

/** 渠道卡只打开管理窗，不把授权表单追加到长列表底部。 */
export function ProviderAccountsPanel({
  onManageChannel,
}: {
  onManageChannel: (channelId: string) => void;
}) {
  const { intl } = useLCodeIntl();
  const accounts = useProviderAccounts();
  const message = (key: string) => intl.formatMessage({ id: `settings.oauth.${key}` });

  if (!accounts.available)
    return (
      <p role="status" className="text-ui-base text-foreground-subtle">
        {message("unavailable")}
      </p>
    );
  return (
    <div className="min-w-0 space-y-5" data-testid="provider-accounts-panel">
      <p className="text-ui-base text-foreground-subtle">{message("description")}</p>
      <ProviderAccountsStatus accounts={accounts} />
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" aria-label={message("channels")}>
        {accounts.view?.channels.map((item) => {
          const count = accounts.view!.accounts.filter(
            (account) => account.channelId === item.id,
          ).length;
          return (
            <button
              key={item.id}
              type="button"
              data-testid={`oauth-channel-${item.id}`}
              aria-haspopup="dialog"
              className="flex min-h-14 min-w-0 items-center justify-between gap-3 rounded-lg border border-border bg-surface px-4 py-3 text-left text-ui-base hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-ring aria-pressed:bg-card-selected"
              onClick={() => onManageChannel(item.id)}
            >
              <span className="min-w-0 break-words font-medium">{item.name}</span>
              <span className="shrink-0 text-ui-sm text-foreground-subtle">
                {intl.formatMessage({ id: "settings.oauth.accountCount" }, { count })}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function ProviderAccountManager({
  channelId,
  accounts,
}: {
  channelId: string;
  accounts: ReturnType<typeof useProviderAccounts>;
}) {
  const { intl } = useLCodeIntl();
  const message = (key: string) => intl.formatMessage({ id: `settings.oauth.${key}` });
  const channel = accounts.view?.channels.find((item) => item.id === channelId);
  const visibleAccounts =
    accounts.view?.accounts.filter((account) => account.channelId === channelId) ?? [];
  return (
    <div className="min-w-0 space-y-5" data-testid="provider-account-manager">
      <ProviderAccountsStatus accounts={accounts} />
      {channel ? (
        <section className="space-y-3" aria-label={channel.name}>
          {channel.error ? (
            <p role="alert" className="break-words text-ui-base text-destructive">
              {message(getProviderAccountDependencyError(channel.error) ?? "channelUnavailable")}
            </p>
          ) : null}
          <ProviderAuthorizationForm key={channel.id} channel={channel} accounts={accounts} />
        </section>
      ) : null}
      {visibleAccounts.length > 0 ? (
        <section className="space-y-3" aria-label={message("accounts")}>
          <h3 className="text-ui-base font-medium">
            {message("accounts")} · {visibleAccounts.length}
          </h3>
          {visibleAccounts.map((account) => (
            <ProviderAccountCard
              key={account.connectionId}
              account={account}
              actions={accounts}
              providerName={channel?.name ?? channelId}
            />
          ))}
        </section>
      ) : accounts.view ? (
        <p className="text-ui-base text-foreground-subtle">{message("emptyAccounts")}</p>
      ) : null}
    </div>
  );
}

function ProviderAccountsStatus({
  accounts,
}: {
  accounts: ReturnType<typeof useProviderAccounts>;
}) {
  const { intl } = useLCodeIntl();
  const message = (key: string) => intl.formatMessage({ id: `settings.oauth.${key}` });
  return (
    <>
      {!accounts.available ? (
        <p role="status" className="text-ui-base text-foreground-subtle">
          {message("unavailable")}
        </p>
      ) : null}
      {accounts.error ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 text-ui-base text-destructive"
        >
          <span>
            {message(
              accounts.error === "load"
                ? "loadError"
                : accounts.error === "action"
                  ? "actionError"
                  : accounts.error,
            )}
          </span>
          <Button type="button" variant="outline" size="sm" onClick={() => void accounts.refresh()}>
            {message("retry")}
          </Button>
        </div>
      ) : null}
      {accounts.loading && !accounts.view ? (
        <p role="status" className="text-ui-base">
          {message("loading")}
        </p>
      ) : null}
    </>
  );
}

function ProviderAccountCard({
  account,
  actions,
  providerName,
}: {
  account: ProviderAccount;
  actions: ReturnType<typeof useProviderAccounts>;
  providerName: string;
}) {
  const { intl, locale } = useLCodeIntl();
  const [showQuota, setShowQuota] = useState(false);
  const message = (key: string) => intl.formatMessage({ id: `settings.oauth.${key}` });
  const busy = actions.busy !== null;
  return (
    <article
      data-oauth-account={account.connectionId}
      data-testid={`oauth-account-${account.connectionId}`}
      className="min-w-0 space-y-3 rounded-lg border border-border bg-surface p-4"
    >
      <div className="flex min-w-0 items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="break-words text-ui-base font-medium">{account.displayName}</div>
          {account.authorizationStatus ? (
            <p className="mt-1 text-ui-sm text-foreground-subtle">
              {message(`authorization.${account.authorizationStatus}`)}
            </p>
          ) : null}
          <p className="mt-1 text-ui-sm text-foreground-subtle">
            {message(`status.${account.status}`)} ·{" "}
            {intl.formatMessage(
              { id: "settings.oauth.modelCount" },
              { count: account.models.length },
            )}
          </p>
        </div>
        <Switch
          checked={account.enabled}
          disabled={busy}
          aria-label={intl.formatMessage(
            { id: "settings.oauth.enableAccount" },
            { name: account.displayName },
          )}
          onCheckedChange={(enabled) =>
            void actions.setAccountEnabled(account.connectionId, enabled)
          }
        />
      </div>
      {account.error ? (
        <p role="alert" className="break-words text-ui-base text-destructive">
          {message(getProviderAccountDependencyError(account.error) ?? "modelCatalogError")}
        </p>
      ) : null}
      {account.models.length ? (
        <details className="text-ui-base">
          <summary className="cursor-pointer text-foreground-subtle">{message("models")}</summary>
          <ul className="mt-2 max-h-60 space-y-1 overflow-y-auto">
            {account.models.map((model) => (
              <li
                key={`${model.protocol}:${model.id}`}
                className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1"
              >
                <span className="min-w-0 break-all">{model.name || model.id}</span>
                {model.contextWindow ? (
                  <span className="text-ui-sm text-foreground-subtle">
                    {intl.formatMessage(
                      { id: "settings.oauth.contextCapacity" },
                      { count: model.contextWindow.toLocaleString(locale) },
                    )}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-expanded={showQuota}
          onClick={() => setShowQuota((value) => !value)}
        >
          {message("viewQuota")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => void actions.refreshModels(account.connectionId)}
        >
          {message("refreshModels")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => void actions.removeAccount(account.connectionId)}
        >
          {message("removeAccount")}
        </Button>
      </div>
      {showQuota ? (
        <ProviderQuotaCard
          account={account}
          providerName={providerName}
          revision={actions.view?.revision ?? 0}
          refreshEpoch={0}
        />
      ) : null}
    </article>
  );
}
