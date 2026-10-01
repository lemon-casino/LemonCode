import { TID_SIDE_PANE_TOGGLE } from "@lcode/shared";
import type { RefObject } from "react";
import { PanelRightClose, PanelRightOpen } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { WINDOWS_CAPTION_CONTROL_CLASS } from "@/windowCaptionControls.js";

export function WorkspaceSidePaneToggleButton({
  isSidePaneOpen,
  onToggleSidePane,
  shortcutLabel,
  useWindowsCaptionSpacing = false,
  buttonRef,
  ariaControls,
}: {
  isSidePaneOpen: boolean;
  onToggleSidePane: () => void;
  shortcutLabel?: string;
  useWindowsCaptionSpacing?: boolean;
  buttonRef?: RefObject<HTMLButtonElement | null>;
  ariaControls?: string;
}) {
  const { intl } = useLCodeIntl();
  const SidePaneToggleIcon = isSidePaneOpen ? PanelRightClose : PanelRightOpen;

  return (
    <ControlHintTooltip
      title={intl.formatMessage({ id: "sidePane.togglePanel" })}
      side="bottom"
      shortcut={shortcutLabel}
    >
      <Button
        ref={buttonRef}
        aria-expanded={isSidePaneOpen}
        aria-controls={ariaControls}
        type="button"
        variant="ghost"
        size="icon-md"
        data-testid={TID_SIDE_PANE_TOGGLE}
        className={cn(
          "text-foreground hover:bg-hover hover:text-foreground [app-region:no-drag]",
          useWindowsCaptionSpacing && WINDOWS_CAPTION_CONTROL_CLASS,
          isSidePaneOpen && "!bg-selected text-foreground",
        )}
        aria-label={intl.formatMessage({
          id: isSidePaneOpen ? "sidePane.collapse" : "sidePane.expand",
        })}
        onClick={onToggleSidePane}
      >
        <SidePaneToggleIcon className="size-4" />
      </Button>
    </ControlHintTooltip>
  );
}
