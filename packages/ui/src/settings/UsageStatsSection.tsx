import { AppUsagePanel } from "@/settings/usage-stats/AppUsagePanel.js";
import { ProviderUsagePanel } from "@/settings/usage-stats/ProviderUsagePanel.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";

export type UsageStatsSectionTab = "app" | "oauth";

export function UsageStatsSection({ activeTab }: { activeTab: UsageStatsSectionTab }) {
  const { intl } = useLCodeIntl();
  if (activeTab === "app") {
    return (
      <section data-testid="api-usage-panel" className="space-y-4">
        <p className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "settings.usage.apiScopeNote" })}
        </p>
        <AppUsagePanel />
      </section>
    );
  }
  return <ProviderUsagePanel />;
}
