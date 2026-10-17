import { useId } from "react";
import { Button } from "@/components/ui/button.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import type { SshProxySelection } from "@/hooks/useRemoteConnectionForm.js";
import { useSshProxyProfiles } from "@/hooks/useSshProxyProfiles.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";

export function SshProxyModeField({
  value,
  onChange,
}: {
  value: SshProxySelection;
  onChange: (value: SshProxySelection) => void;
}) {
  const id = useId();
  const { intl } = useLCodeIntl();
  const { status, profiles, reload } = useSshProxyProfiles();
  const message = (key: string) => intl.formatMessage({ id: `ssh.proxy.${key}` });
  const missing =
    status === "ready" &&
    value.kind === "profile" &&
    !profiles.some((profile) => profile.id === value.profileId);
  const selectedValue = value.kind === "profile" ? `profile:${value.profileId}` : value.kind;
  return (
    <div className="min-w-0 space-y-2 rounded-lg border border-input-border p-3">
      <label htmlFor={id} className="block text-ui-base text-foreground">
        {intl.formatMessage({ id: "ssh.proxyMode" })}
      </label>
      <Select
        value={selectedValue}
        onValueChange={(next) =>
          onChange(
            next.startsWith("profile:")
              ? { kind: "profile", profileId: next.slice("profile:".length) }
              : { kind: next === "default" ? "default" : "direct" },
          )
        }
      >
        <SelectTrigger
          id={id}
          data-testid="ssh-proxy-mode"
          className="w-full min-w-0"
          aria-describedby={`${id}-description`}
          aria-invalid={missing || undefined}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper" align="start">
          <SelectItem value="direct">{message("direct")}</SelectItem>
          <SelectItem value="default">{message("default")}</SelectItem>
          {profiles.map((profile) => (
            <SelectItem key={profile.id} value={`profile:${profile.id}`}>
              {profile.name} · {profile.address}
            </SelectItem>
          ))}
          {value.kind === "profile" &&
          !profiles.some((profile) => profile.id === value.profileId) ? (
            <SelectItem value={selectedValue} disabled>
              {message("unavailable")}
            </SelectItem>
          ) : null}
        </SelectContent>
      </Select>
      <p id={`${id}-description`} className="text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "ssh.proxyModeDescription" })}
      </p>
      {status === "loading" ? (
        <p role="status" className="text-ui-sm text-foreground-subtle">
          {message("loading")}
        </p>
      ) : null}
      {status === "error" ? (
        <div className="flex flex-wrap items-center gap-2">
          <p role="alert" className="text-ui-sm text-destructive">
            {message("loadError")}
          </p>
          <Button type="button" size="sm" variant="outline" onClick={reload}>
            {message("retry")}
          </Button>
        </div>
      ) : null}
      {missing ? (
        <p role="alert" className="text-ui-sm text-destructive">
          {message("missing")}
        </p>
      ) : null}
      {status === "ready" && !profiles.length && !missing ? (
        <p className="text-ui-sm text-foreground-subtle">{message("empty")}</p>
      ) : null}
    </div>
  );
}
