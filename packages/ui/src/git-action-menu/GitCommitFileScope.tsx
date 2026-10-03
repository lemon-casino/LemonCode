import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";

export function GitCommitFileScope({
  includeUnstaged,
  hasUnstaged,
  fileCount,
  excludedCount,
  totalCount,
  disabled,
  onIncludeUnstagedChange,
  onOpenFiles,
  canOpenFiles,
  readOnly = false,
}: {
  includeUnstaged: boolean;
  hasUnstaged: boolean;
  fileCount: number;
  excludedCount: number;
  totalCount: number;
  disabled: boolean;
  onIncludeUnstagedChange: (value: boolean) => void;
  onOpenFiles: () => void;
  canOpenFiles: boolean;
  readOnly?: boolean;
}) {
  const { intl } = useLCodeIntl();
  return (
    <div className="space-y-2 px-4 py-2 text-ui-sm">
      <h2 className="font-medium">{intl.formatMessage({ id: "git.review.fileScope" })}</h2>
      {!readOnly ? (
        <label className="flex items-start gap-2 leading-6">
          <Checkbox
            className="mt-1"
            data-testid="git-commit-include-unstaged"
            checked={includeUnstaged}
            disabled={disabled || !hasUnstaged}
            onCheckedChange={(value) => onIncludeUnstagedChange(value === true)}
          />
          <span className="min-w-0 flex-1">
            {intl.formatMessage({ id: "git.actionMenu.commitDialog.includeUnstaged" })}
          </span>
        </label>
      ) : (
        <p className="text-foreground-subtle">
          {intl.formatMessage({ id: "git.review.sourceReadOnly" })}
        </p>
      )}
      <p data-testid="git-commit-scope-counts" className="text-foreground-subtle">
        {intl.formatMessage(
          { id: "git.review.scopeCounts" },
          { selected: fileCount, excluded: excludedCount, total: totalCount },
        )}
      </p>
      <Button
        type="button"
        size="sm"
        variant="outline"
        data-testid="git-scope-open-files"
        disabled={!canOpenFiles}
        onClick={onOpenFiles}
      >
        {intl.formatMessage({
          id: readOnly ? "git.review.viewSourceFiles" : "git.review.manageFileScope",
        })}
      </Button>
    </div>
  );
}
