import { Button } from "@/components/ui/button.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { WORKTREE_REVIEW_STAGES } from "./worktreeReviewStages.js";

export function WorktreeReviewStageNavigation({
  stage,
  currentStage,
  onStage,
  onCurrent,
}: {
  stage: number;
  currentStage: number;
  onStage: (stage: number) => void;
  onCurrent: () => void;
}) {
  const { intl } = useLCodeIntl();
  const readOnly = stage < currentStage;
  return (
    <nav
      className="flex flex-wrap items-center gap-2 border-b border-border pb-2 text-ui-sm"
      aria-label={intl.formatMessage({ id: "git.review.stages" })}
    >
      {WORKTREE_REVIEW_STAGES.map((name, index) => (
        <Button
          key={name}
          type="button"
          size="xs"
          variant={index === stage ? "secondary" : "ghost"}
          disabled={index > currentStage}
          aria-current={index === stage ? "step" : undefined}
          onClick={() => onStage(index)}
        >
          {intl.formatMessage({ id: `worktree.stage.${name}` })}
        </Button>
      ))}
      {stage > 0 ? (
        <Button
          type="button"
          size="xs"
          variant="outline"
          data-testid="worktree-stage-back"
          onClick={() => onStage(stage - 1)}
        >
          {intl.formatMessage({ id: "git.review.back" })}
        </Button>
      ) : null}
      {readOnly ? (
        <>
          <p className="text-foreground-subtle">
            {intl.formatMessage({ id: "git.review.stageReadOnly" })}
          </p>
          <Button
            type="button"
            size="xs"
            variant="outline"
            data-testid="worktree-current-stage"
            onClick={onCurrent}
          >
            {intl.formatMessage({ id: "git.review.currentStage" })}
          </Button>
        </>
      ) : null}
    </nav>
  );
}
