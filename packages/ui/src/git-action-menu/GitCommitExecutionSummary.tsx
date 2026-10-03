import type { GitRepositorySummary, SessionExecutionMode } from "@lcode/shared";
import { GitBranchIcon } from "lucide-react";
import { GitBranchSwitcher } from "@/GitBranchSwitcher.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";

export function GitCommitExecutionSummary({
  workspacePath,
  executionMode,
  summary,
  locked,
  fileCount,
  added,
  removed,
  onRefreshGit,
}: {
  workspacePath: string;
  executionMode: SessionExecutionMode;
  summary: GitRepositorySummary;
  locked: boolean;
  fileCount: number;
  added: number;
  removed: number;
  onRefreshGit: () => void;
}) {
  const { intl, locale } = useLCodeIntl();
  const text = (field: string) =>
    intl.formatMessage({ id: `git.commitWorkflow.${executionMode}.${field}` });
  const number = new Intl.NumberFormat(locale);
  return (
    <>
      <div className="space-y-1 px-4 pt-3 text-ui-sm" data-testid="git-commit-execution-summary">
        <p className="text-foreground-subtle">{text("hint")}</p>
        <p className="break-all">
          {intl.formatMessage({ id: "git.commitWorkflow.directory" })}{" "}
          <span className="font-mono">{workspacePath}</span>
        </p>
        <p className="text-foreground-subtle">{text("branchLabel")}</p>
      </div>
      <div className="flex min-w-0 items-center justify-between gap-2 px-4 py-3">
        {locked ? (
          <span className="flex min-w-0 items-center gap-1 font-mono text-ui-sm">
            <GitBranchIcon className="size-4 shrink-0" />
            <span className="truncate">
              {summary.branchName ?? intl.formatMessage({ id: "git.head.detached" })}
            </span>
          </span>
        ) : (
          <GitBranchSwitcher
            workspacePath={workspacePath}
            gitSummary={summary}
            dirtyFileCount={fileCount}
            onRefreshGit={onRefreshGit}
            className="min-w-0 px-0 pt-0"
            triggerClassName="h-7 max-w-56 justify-start px-1.5 text-foreground-subtle [&>span]:max-w-40"
            popoverSide="bottom"
            popoverClassName="w-80 max-w-[calc(100vw-2rem)]"
            branchListClassName="max-h-56"
            showFooterActions={false}
          />
        )}
        <div className="flex shrink-0 gap-1.5 font-mono text-ui-sm">
          <span className="text-diff-added">+{number.format(added)}</span>
          <span className="text-diff-removed">−{number.format(removed)}</span>
        </div>
      </div>
    </>
  );
}
