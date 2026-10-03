import { Button } from "@/components/ui/button.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";

export function GitReviewStageNavigation({
  showMerge,
  onBack,
}: {
  showMerge: boolean;
  onBack: () => void;
}) {
  const { intl } = useLCodeIntl();
  return (
    <nav
      className="flex flex-wrap items-center gap-2 border-y border-border px-4 py-2 text-ui-sm"
      aria-label={intl.formatMessage({ id: "git.review.stages" })}
    >
      <span>
        {intl.formatMessage({ id: showMerge ? "git.review.stageMerge" : "git.review.stageCommit" })}
      </span>
      <Button
        type="button"
        size="sm"
        variant="outline"
        data-testid="git-review-stage-back"
        onClick={onBack}
      >
        {intl.formatMessage({ id: showMerge ? "git.review.back" : "git.review.currentStage" })}
      </Button>
    </nav>
  );
}
