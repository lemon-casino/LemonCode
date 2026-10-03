import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";

export function ReviewDialogDismiss({ onClose }: { onClose: () => void }) {
  const { intl } = useLCodeIntl();
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className="absolute right-2 top-2"
      data-testid="git-review-dismiss"
      aria-label={intl.formatMessage({ id: "common.close" })}
      onClick={onClose}
    >
      <XIcon className="size-4" />
    </Button>
  );
}
