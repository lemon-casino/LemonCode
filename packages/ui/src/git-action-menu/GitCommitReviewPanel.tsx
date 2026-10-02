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
  expandedFiles,
  acknowledged,
  disabled,
  onBrowse,
  onExpandedFilesChange,
  onExclude,
  onAcknowledge,
  onManualFallback,
}: {
  review: GitCommitReview;
  position: number;
  browsePosition: number;
  expandedFiles: readonly string[];
  acknowledged: boolean;
  disabled: boolean;
  onBrowse: (position: number) => void;
  onExpandedFilesChange: (paths: string[]) => void;
  onExclude: (path: string) => void;
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
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid="git-review-prev"
          disabled={disabled || browsePosition <= 0}
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
          disabled={disabled || browsePosition >= review.groups.length - 1}
          onClick={() => onBrowse(browsePosition + 1)}
        >
          {intl.formatMessage({ id: "git.review.next" })}
        </Button>
      </div>
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
          <div className="flex flex-wrap gap-1">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              data-testid="git-review-expand-all"
              onClick={() => onExpandedFilesChange(group.files.map((file) => file.path))}
            >
              {intl.formatMessage({ id: "git.review.expandAll" })}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              data-testid="git-review-collapse-all"
              onClick={() => onExpandedFilesChange([])}
            >
              {intl.formatMessage({ id: "git.review.collapseAll" })}
            </Button>
          </div>
          <div
            data-testid="git-review-files"
            className="max-h-72 space-y-2 overflow-y-auto overscroll-contain pr-1"
          >
            {group.files.map((file) => (
              <details
                key={`${group.id}:${file.path}`}
                open={expandedFiles.includes(file.path)}
                className="min-w-0 rounded-xl border border-border p-2"
                onToggle={(event) => {
                  if (event.currentTarget.open !== expandedFiles.includes(file.path))
                    onExpandedFilesChange(
                      event.currentTarget.open
                        ? [...expandedFiles, file.path]
                        : expandedFiles.filter((path) => path !== file.path),
                    );
                }}
              >
                <summary className="cursor-pointer break-all font-mono">
                  {file.path} <span className="text-diff-added">+{file.added}</span>{" "}
                  <span className="text-diff-removed">−{file.removed}</span>
                </summary>
                <div className="flex justify-end">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={disabled}
                    data-testid={`git-review-exclude-${file.path}`}
                    onClick={() => onExclude(file.path)}
                  >
                    {intl.formatMessage({ id: "git.review.exclude" })}
                  </Button>
                </div>
                <pre
                  className="mt-2 max-h-44 max-w-full overflow-auto whitespace-pre font-mono text-ui-sm"
                  tabIndex={0}
                >
                  {file.patch}
                </pre>
              </details>
            ))}
          </div>
        </>
      ) : null}
      <p className="text-foreground-subtle">{intl.formatMessage({ id: "git.review.frozen" })}</p>
    </section>
  );
}
