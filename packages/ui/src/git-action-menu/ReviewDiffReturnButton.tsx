import { ArrowLeftIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { useReviewDiffNavigationStore } from "@/store/reviewDiffNavigationStore.js";

export function ReviewDiffReturnButton({ token }: { token?: string }) {
  const { intl } = useLCodeIntl();
  const onReturn = useReviewDiffNavigationStore((state) =>
    token ? state.returns[token]?.reopen : undefined,
  );
  if (!onReturn) return null;
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="shrink-0"
      data-testid="code-viewer-return-review"
      onClick={onReturn}
    >
      <ArrowLeftIcon className="size-4" />
      {intl.formatMessage({ id: "git.review.returnToDialog" })}
    </Button>
  );
}
