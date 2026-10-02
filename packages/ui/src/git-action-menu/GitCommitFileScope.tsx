import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import type { GitBranchCommitPreviewFile } from "@/git-branch-switcher/display.js";

export function GitCommitFileScope({
  includeUnstaged,
  hasUnstaged,
  fileCount,
  files,
  excludedFiles,
  hasReview,
  disabled,
  onIncludeUnstagedChange,
  onExclude,
  onRestoreFile,
}: {
  includeUnstaged: boolean;
  hasUnstaged: boolean;
  fileCount: number;
  files: GitBranchCommitPreviewFile[];
  excludedFiles: string[];
  hasReview: boolean;
  disabled: boolean;
  onIncludeUnstagedChange: (value: boolean) => void;
  onExclude: (path: string) => void;
  onRestoreFile: (path: string) => void;
}) {
  const { intl } = useLCodeIntl();
  return (
    <div className="space-y-2 px-4 py-2">
      <label className="flex items-start gap-2 text-ui-sm leading-6">
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
        <span className="shrink-0 text-foreground-subtle">
          {intl.formatMessage(
            { id: "git.actionMenu.commitDialog.changesValue" },
            { count: fileCount },
          )}
        </span>
      </label>
      {!hasReview && files.length ? (
        <details className="min-w-0 text-ui-sm">
          <summary className="cursor-pointer">
            {intl.formatMessage({ id: "git.review.fileScope" })}
          </summary>
          <ul className="max-h-40 space-y-1 overflow-y-auto">
            {files
              .filter((file) => !excludedFiles.includes(file.repoRelativePath))
              .map((file) => (
                <li key={file.repoRelativePath} className="flex min-w-0 items-start gap-1">
                  <span className="min-w-0 flex-1 break-all font-mono">
                    {file.repoRelativePath}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    disabled={disabled}
                    data-testid={`git-review-exclude-${file.repoRelativePath}`}
                    onClick={() => onExclude(file.repoRelativePath)}
                  >
                    {intl.formatMessage({ id: "git.review.exclude" })}
                  </Button>
                </li>
              ))}
          </ul>
        </details>
      ) : null}
      {excludedFiles.length ? (
        <div className="min-w-0 space-y-1 text-ui-sm">
          <p className="text-foreground-subtle">
            {intl.formatMessage({ id: "git.review.excluded" })}
          </p>
          {excludedFiles.map((path) => (
            <div key={path} className="flex min-w-0 items-start gap-1">
              <span className="min-w-0 flex-1 break-all font-mono">{path}</span>
              <Button
                type="button"
                variant="outline"
                size="xs"
                disabled={disabled}
                data-testid={`git-review-restore-${path}`}
                onClick={() => onRestoreFile(path)}
              >
                {intl.formatMessage({ id: "git.review.restoreFile" })}
              </Button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
