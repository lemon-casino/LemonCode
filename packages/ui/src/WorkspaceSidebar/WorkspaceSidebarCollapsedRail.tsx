import { PanelLeftOpen } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";

export function WorkspaceSidebarCollapsedRail({
  onToggleSidebar,
  toggleSidebarShortcutLabel,
}: {
  onToggleSidebar: () => void;
  toggleSidebarShortcutLabel?: string;
}) {
  const { intl } = useLCodeIntl();

  return (
    <aside className="flex h-full flex-col overflow-hidden border-r border-border bg-background-alt">
      <div className="flex h-9 shrink-0 items-center justify-center border-b border-border bg-background-alt px-1.5 [app-region:drag]">
        <div className="[app-region:no-drag]">
          <ControlHintTooltip
            title={intl.formatMessage({ id: "workspaceSidebar.toggleSidebar" })}
            shortcut={toggleSidebarShortcutLabel}
            side="bottom"
          >
            {/* 品牌徽标不再兼任折叠按钮：收起栏顶部直接显示展开图标（与顶部浮层折叠图标一致）。 */}
            <Button
              type="button"
              variant="ghost"
              size="icon-md"
              className="rounded-lg"
              onClick={onToggleSidebar}
              aria-label={intl.formatMessage({
                id: "workspaceSidebar.toggleSidebar",
              })}
            >
              <PanelLeftOpen className="size-4" />
            </Button>
          </ControlHintTooltip>
        </div>
      </div>
    </aside>
  );
}
