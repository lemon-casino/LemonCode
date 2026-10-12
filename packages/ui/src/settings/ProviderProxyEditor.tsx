import { useEffect, useId, useState } from "react";
import type { ProviderConfigObject, ProviderSettingsProviderView } from "@lcode/provider";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useProviderNetwork } from "@/hooks/useProviderNetwork.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { setPendingSettingsSection } from "@/lib/settingsNavigation.js";
import { isNetworkProxyUrl, type ProxyProfile } from "@lcode/shared";
import { ProxyAddressInput } from "./ProxyAddressInput.js";

type Network = NonNullable<ProviderConfigObject["network"]>;

export function ProviderProxyEditor({
  providerId,
  channelId,
}: {
  providerId?: string;
  channelId?: string;
}) {
  const services = useOptionalServices();
  return services?.providerSettingsService ? (
    <ProviderProxyConnected providerId={providerId} channelId={channelId} />
  ) : null;
}

function ProviderProxyConnected({
  providerId,
  channelId,
}: {
  providerId?: string;
  channelId?: string;
}) {
  const source = useProviderNetwork();
  const provider =
    source.state.status === "ready"
      ? source.state.view.providers.find((item) =>
          providerId
            ? item.providerId === providerId
            : item.effectiveConfig.access?.type === "oauth-account" &&
              item.effectiveConfig.access.channelId === channelId,
        )
      : undefined;
  return provider ? (
    <ProviderProxyFields
      provider={provider}
      profiles={source.state.status === "ready" ? (source.state.view.proxyProfiles ?? []) : []}
      onSave={source.save}
    />
  ) : null;
}

function ProviderProxyFields({
  provider,
  profiles,
  onSave,
}: {
  provider: ProviderSettingsProviderView;
  profiles: readonly ProxyProfile[];
  onSave: (providerId: string, network: Network) => Promise<void>;
}) {
  const { intl } = useLCodeIntl();
  const id = useId();
  const message = (key: string) => intl.formatMessage({ id: `settings.proxy.${key}` });
  const network = provider.effectiveConfig.network;
  const signature = JSON.stringify(network ?? { mode: "default" });
  const [mode, setMode] = useState<Network["mode"]>(network?.mode ?? "default");
  const [profileId, setProfileId] = useState(network?.mode === "profile" ? network.profileId : "");
  const [httpProxy, setHttpProxy] = useState(network?.mode === "custom" ? network.httpProxy : "");
  const [noProxy, setNoProxy] = useState(network?.mode === "custom" ? (network.noProxy ?? "") : "");
  const [caCertPath, setCaCertPath] = useState(
    network?.mode === "custom" ? (network.caCertPath ?? "") : "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    const value: Network = JSON.parse(signature);
    setMode(value.mode);
    setProfileId(value.mode === "profile" ? value.profileId : "");
    setHttpProxy(value.mode === "custom" ? value.httpProxy : "");
    setNoProxy(value.mode === "custom" ? (value.noProxy ?? "") : "");
    setCaCertPath(value.mode === "custom" ? (value.caCertPath ?? "") : "");
    setError(false);
  }, [signature, provider.providerId]);
  const draft: Network =
    mode === "custom"
      ? {
          mode,
          httpProxy: httpProxy.trim(),
          ...(noProxy.trim() ? { noProxy: noProxy.trim() } : {}),
          ...(caCertPath.trim() ? { caCertPath: caCertPath.trim() } : {}),
        }
      : mode === "profile"
        ? { mode, profileId }
        : { mode };
  let valid = true;
  if (mode === "custom") {
    valid = isNetworkProxyUrl(httpProxy.trim());
  }
  if (mode === "profile") valid = profiles.some((profile) => profile.id === profileId);
  const dirty = JSON.stringify(draft) !== signature;
  return (
    <form
      data-provider-proxy={provider.providerId}
      className="min-w-0 space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!dirty || !valid || busy) return;
        setBusy(true);
        setError(false);
        void onSave(provider.providerId, draft)
          .catch(() => setError(true))
          .finally(() => setBusy(false));
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`${id}-mode`} className="text-ui-base text-foreground-subtle">
          {message("connection")}
        </label>
        <Select
          value={mode === "profile" ? `profile:${profileId}` : mode}
          onValueChange={(value) => {
            if (value.startsWith("profile:")) {
              setProfileId(value.slice(8));
              setMode("profile");
            } else setMode(value as Network["mode"]);
          }}
          disabled={busy}
        >
          <SelectTrigger id={`${id}-mode`} className="w-full sm:w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(["default", "direct"] as const).map((value) => (
              <SelectItem key={value} value={value}>
                {message(value)}
              </SelectItem>
            ))}
            {profiles.map((profile) => (
              <SelectItem key={profile.id} value={`profile:${profile.id}`}>
                {profile.name}
              </SelectItem>
            ))}
            <SelectItem value="custom">{message("custom")}</SelectItem>
          </SelectContent>
        </Select>
        <Button type="submit" size="sm" disabled={busy || !dirty || !valid}>
          {intl.formatMessage({ id: "settings.dataBaseDirSave" })}
        </Button>
        {mode === "default" ? (
          // 英文标签在手机大字号下超过父栏宽度；限制宽度并允许换行，保留原导航行为。
          <Button
            type="button"
            size="sm"
            variant="link"
            className="h-auto max-w-full whitespace-normal"
            onClick={() => setPendingSettingsSection("proxy")}
          >
            {message("manageDefault")}
          </Button>
        ) : null}
      </div>
      {mode === "custom" ? (
        <div className="grid min-w-0 gap-3 lg:grid-cols-2">
          <div className="min-w-0 lg:col-span-2">
            <ProxyAddressInput value={httpProxy} onChange={setHttpProxy} disabled={busy} />
          </div>
          {[
            { key: "httpProxyNoProxy", value: noProxy, change: setNoProxy },
            { key: "httpProxyCaCertPath", value: caCertPath, change: setCaCertPath },
          ].map((field) => (
            <label
              key={field.key}
              className="min-w-0 space-y-1 text-ui-base text-foreground-subtle"
            >
              <span>{intl.formatMessage({ id: `settings.${field.key}` })}</span>
              <Input
                value={field.value}
                disabled={busy}
                className="font-mono"
                placeholder={intl.formatMessage({ id: `settings.${field.key}Placeholder` })}
                onChange={(event) => field.change(event.target.value)}
              />
            </label>
          ))}
          {!valid && httpProxy ? (
            <p role="alert" className="text-ui-sm text-destructive">
              {message("invalid")}
            </p>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-ui-sm text-destructive">
          {message("saveError")}
        </p>
      ) : null}
    </form>
  );
}
