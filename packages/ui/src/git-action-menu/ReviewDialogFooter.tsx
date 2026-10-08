import { Button } from "@/components/ui/button.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";

export function ReviewDialogFooter({
  onClose,
  actionSlotRef,
}: {
  onClose: () => void;
  actionSlotRef: (value: HTMLDivElement | null) => void;
}) {
  const { intl } = useLCodeIntl();
  return (
    <div
      className="flex shrink-0 items-end gap-2 border-t border-border bg-popover px-4 py-3"
      data-testid="git-review-footer"
    >
      <div
        ref={actionSlotRef}
        className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2"
      />
      <Button type="button" variant="ghost" data-testid="git-commit-close" onClick={onClose}>
        {intl.formatMessage({ id: "common.close" })}
      </Button>
    </div>
  );
}
