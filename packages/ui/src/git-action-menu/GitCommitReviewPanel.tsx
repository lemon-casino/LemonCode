import type { GitCommitReview } from "@lcode/shared";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { selectCommitReviewGroup } from "./commitReviewModel.js";

const WARNING_IDS: Record<string, string> = {
  "incomplete-journal": "git.review.incomplete",
  "ambiguous-version-chain": "git.review.ambiguous",
  "dependency-cycle": "git.review.cycle",
  "unattributed-write": "git.review.incomplete",
  "review-truncated": "git.review.truncated",
  "ai-recommended-merge": "git.review.aiMerge",
};
export function GitCommitReviewPanel({
  review,
  position,
  browsePosition,
  acknowledged,
  disabled,
  navigationDisabled,
  onBrowse,
  onAcknowledge,
  onManualFallback,
  onOpenFiles,
  canOpenFiles,
}: {
  onOpenFiles: () => void;
  canOpenFiles: boolean;
  review: GitCommitReview;
  position: number;
  browsePosition: number;
  acknowledged: boolean;
  disabled: boolean;
  navigationDisabled: boolean;
  onBrowse: (position: number) => void;
  onAcknowledge: (value: boolean) => void;
  onManualFallback: () => void;
}) {
  const { intl } = useLCodeIntl();
  const group = selectCommitReviewGroup(review, browsePosition);
  const authoritative = browsePosition === position;
  return (
    <section
      className="min-w-0 space-y-2 border-t border-border px-4 py-3 text-ui-sm"
      data-testid="git-commit-review"
    >
      <p className="font-medium">{intl.formatMessage({ id: `git.review.mode.${review.mode}` })}</p>
      {review.warnings.map((warning, index) => (
        <p key={index} className="break-words text-warning">
          {WARNING_IDS[warning] ? intl.formatMessage({ id: WARNING_IDS[warning] }) : warning}
        </p>
      ))}
      {authoritative && group?.requiresConfirmation ? (
        <label className="flex items-start gap-2 leading-6">
          <Checkbox
            className="mt-1"
            data-testid="git-review-acknowledge"
            checked={acknowledged}
            disabled={disabled}
            onCheckedChange={(value) => onAcknowledge(value === true)}
          />
          <span className="min-w-0">{intl.formatMessage({ id: "git.review.acknowledge" })}</span>
        </label>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={disabled}
        data-testid="git-review-manual-fallback"
        onClick={onManualFallback}
      >
        {intl.formatMessage({ id: "git.review.manual" })}
      </Button>
      {group?.dependsOn.length ? (
        <p className="break-words text-foreground-subtle">
          {intl.formatMessage(
            { id: "git.review.dependencies" },
            {
              groups: group.dependsOn
                .map((id) => review.groups.find((item) => item.id === id)?.label || id)
                .join(", "),
            },
          )}
        </p>
      ) : null}
      <p className="text-foreground-subtle">
        {position >= review.groups.length
          ? intl.formatMessage({ id: "git.review.complete" })
          : intl.formatMessage(
              { id: "git.review.progress" },
              { current: position + 1, total: review.groups.length },
            )}
      </p>
      {review.groups.length > 1 ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="git-review-prev"
            disabled={navigationDisabled || browsePosition <= 0}
            onClick={() => onBrowse(browsePosition - 1)}
          >
            {intl.formatMessage({ id: "git.review.previous" })}
          </Button>
          <span className="text-foreground-subtle">
            {browsePosition + 1} / {review.groups.length}
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="git-review-next"
            disabled={navigationDisabled || browsePosition >= review.groups.length - 1}
            onClick={() => onBrowse(browsePosition + 1)}
          >
            {intl.formatMessage({ id: "git.review.next" })}
          </Button>
        </div>
      ) : null}
      {!authoritative ? (
        <p className="text-warning">{intl.formatMessage({ id: "git.review.browseOnly" })}</p>
      ) : null}
      {group ? (
        <>
          <p className="break-words font-medium">
            {group.label || intl.formatMessage({ id: "git.review.mergedLabel" })}
          </p>
          {!authoritative ? (
            <p className="whitespace-pre-wrap break-words font-mono">{group.message}</p>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="git-review-open-files"
            disabled={!canOpenFiles}
            onClick={onOpenFiles}
          >
            {intl.formatMessage(
              { id: "git.review.openFileWorkspace" },
              { count: group.files.length },
            )}
          </Button>
        </>
      ) : null}
      <p className="text-foreground-subtle">{intl.formatMessage({ id: "git.review.frozen" })}</p>
    </section>
  );
}
