import { GitCommitIcon, LoaderIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";

export function ConversationCommitMessageButton({
  onClick,
  pending = false,
  disabled = false,
}: {
  onClick?: () => void;
  pending?: boolean;
  disabled?: boolean;
}) {
  const { intl } = useLCodeIntl();
  if (!onClick) return null;
  const label = intl.formatMessage({
    id: pending ? "git.commitSummary.generating" : "git.commitSummary.generate",
  });
  return (
    <ControlHintTooltip title={label}>
      <Button
        type="button"
        variant="ghost"
        size="icon-md"
        disabled={disabled || pending}
        onClick={onClick}
        aria-label={label}
        data-testid="v4-composer-commit-summary"
      >
        {pending ? (
          <LoaderIcon className="size-4 animate-spin" />
        ) : (
          <GitCommitIcon className="size-4" />
        )}
      </Button>
    </ControlHintTooltip>
  );
}
