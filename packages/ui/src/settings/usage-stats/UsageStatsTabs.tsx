import { TID_SETTINGS_USAGE_TAB, testId } from "@lcode/shared";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { SegmentPill } from "@/settings/PluginStoreListView.js";
import type { UsageStatsSectionTab } from "@/settings/UsageStatsSection.js";

export function UsageStatsTabs({
  activeTab,
  onTabChange,
}: {
  activeTab: UsageStatsSectionTab;
  onTabChange: (tab: UsageStatsSectionTab) => void;
}) {
  const { intl } = useLCodeIntl();
  return (
    <div
      className="flex flex-wrap items-center gap-1.5"
      aria-label={intl.formatMessage({ id: "settings.usage.connectionType" })}
    >
      {(["app", "oauth"] as const).map((tab) => (
        <SegmentPill
          key={tab}
          active={activeTab === tab}
          label={intl.formatMessage({
            id: tab === "app" ? "settings.usage.tab.appUsage" : "settings.usage.tab.oauth",
          })}
          testId={testId(TID_SETTINGS_USAGE_TAB, tab)}
          onClick={() => onTabChange(tab)}
        />
      ))}
    </div>
  );
}
