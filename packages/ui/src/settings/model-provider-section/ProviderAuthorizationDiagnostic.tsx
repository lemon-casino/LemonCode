import type { ProviderAuthorizationDiagnostic as Diagnostic } from "@lcode/shared";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
export function ProviderAuthorizationDiagnostic({ diagnostic }: { diagnostic: Diagnostic }) {
  const { intl } = useLCodeIntl();
  return (
    <p
      role="status"
      data-testid="oauth-authorization-diagnostic"
      className="break-words text-ui-base text-foreground-subtle"
    >
      {diagnostic.credentialsSaved
        ? intl.formatMessage({ id: "settings.oauth.credentialsSaved" }) + " · "
        : ""}
      {intl.formatMessage({ id: "settings.oauth.phase." + diagnostic.phase })}
      {diagnostic.code
        ? " · " + intl.formatMessage({ id: "settings.oauth.failure." + diagnostic.code })
        : ""}
      {diagnostic.status ? " (HTTP " + diagnostic.status + ")" : ""}
    </p>
  );
}
