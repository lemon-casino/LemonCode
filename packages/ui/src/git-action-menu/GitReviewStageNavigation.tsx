import { Button } from "@/components/ui/button.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";

export function GitReviewStageNavigation({
  showMerge,
  publishedTarget,
  disabled,
  onBack,
}: {
  showMerge: boolean;
  publishedTarget?: string;
  disabled?: boolean;
  onBack: () => void;
}) {
  const { intl } = useLCodeIntl();
  return (
    <nav
      className="flex flex-wrap items-center gap-2 border-y border-border px-4 py-2 text-ui-sm"
      aria-label={intl.formatMessage({ id: "git.review.stages" })}
    >
      <span className="min-w-0 break-all">
        {showMerge && publishedTarget
          ? intl.formatMessage({ id: "git.review.mergeResult" }, { branch: publishedTarget })
          : intl.formatMessage({
              id: showMerge ? "git.review.stageMerge" : "git.review.stageCommit",
            })}
      </span>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-auto min-h-8 max-w-full whitespace-normal break-all text-left"
        data-testid="git-review-stage-back"
        disabled={disabled}
        onClick={onBack}
      >
        {publishedTarget
          ? intl.formatMessage(
              { id: showMerge ? "git.review.returnSource" : "git.review.openMergedPublication" },
              { branch: publishedTarget },
            )
          : intl.formatMessage({ id: showMerge ? "git.review.back" : "git.review.currentStage" })}
      </Button>
    </nav>
  );
}
