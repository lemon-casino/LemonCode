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
  acknowledged,
  disabled,
  onAcknowledge,
  onManualFallback,
}: {
  review: GitCommitReview;
  position: number;
  acknowledged: boolean;
  disabled: boolean;
  onAcknowledge: (value: boolean) => void;
  onManualFallback: () => void;
}) {
  const { intl } = useLCodeIntl();
  const group = selectCommitReviewGroup(review, position);
  return (
    <section
      className="space-y-2 border-t border-border px-4 py-3 text-ui-sm"
      data-testid="git-commit-review"
    >
      <p className="font-medium">{intl.formatMessage({ id: `git.review.mode.${review.mode}` })}</p>
      <p className="text-foreground-subtle">
        {intl.formatMessage(
          { id: "git.review.progress" },
          { current: Math.min(position + 1, review.groups.length), total: review.groups.length },
        )}
      </p>
      {review.warnings.map((warning, index) => (
        <p key={index} className="break-words text-foreground-subtle">
          {WARNING_IDS[warning] ? intl.formatMessage({ id: WARNING_IDS[warning] }) : warning}
        </p>
      ))}
      {group ? (
        <>
          <p className="break-words">
            {group.label || intl.formatMessage({ id: "git.review.mergedLabel" })}
          </p>
          {group.dependsOn.length > 0 ? (
            <p className="text-foreground-subtle">
              {intl.formatMessage(
                { id: "git.review.dependencies" },
                {
                  groups: group.dependsOn
                    .map((id) => review.groups.find((item) => item.id === id)?.label || id)
                    .join("、"),
                },
              )}
            </p>
          ) : null}
          {group.files.map((file) => (
            <details key={file.path} className="min-w-0 rounded-lg border border-border p-2">
              <summary className="cursor-pointer break-all font-mono">
                {file.path} <span className="text-diff-added">+{file.added}</span>{" "}
                <span className="text-diff-removed">−{file.removed}</span>
              </summary>
              <pre
                className="mt-2 max-h-44 overflow-auto whitespace-pre font-mono text-xs"
                tabIndex={0}
              >
                {file.patch}
              </pre>
            </details>
          ))}
          {group.requiresConfirmation ? (
            <label className="flex items-start gap-2 leading-6">
              {/* 原生 input 顶边对齐会偏离文字中心；固定控件尺寸并对齐首行，换行时不漂移。 */}
              <Checkbox
                className="mt-1"
                data-testid="git-review-acknowledge"
                checked={acknowledged}
                disabled={disabled}
                onCheckedChange={(value) => onAcknowledge(value === true)}
              />
              <span className="min-w-0">
                {intl.formatMessage({ id: "git.review.acknowledge" })}
              </span>
            </label>
          ) : null}
        </>
      ) : (
        <p>{intl.formatMessage({ id: "git.review.complete" })}</p>
      )}
      <p className="text-foreground-subtle">{intl.formatMessage({ id: "git.review.frozen" })}</p>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={disabled}
        onClick={onManualFallback}
      >
        {intl.formatMessage({ id: "git.review.manual" })}
      </Button>
    </section>
  );
}
