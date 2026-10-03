import { useCallback, useEffect, useRef, type ReactNode } from "react";
import type { GitCommitReview } from "@lcode/shared";
import { GitBranchIcon, GitCommitIcon, LoaderIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Command, CommandItem, CommandList, CommandShortcut } from "@/components/ui/command.js";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog.js";
import { GitBranchSwitcher } from "@/GitBranchSwitcher.js";
import { hasGitCommitIdentity } from "@/git-branch-switcher/switchAssist.js";
import { getGitBranchCommitTotals } from "@/git-branch-switcher/display.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { formatCommandShortcutLabel, matchesPrimaryShortcut } from "@/lib/keyboardShortcuts.js";
import {
  getCommitDialogFiles,
  getCommitDialogStagePaths,
  type GitCommitDialogState,
} from "./commitDialogModel.js";
import { GitCommitMessageEditor } from "./GitCommitMessageEditor.js";
import { GitCommitFileScope } from "./GitCommitFileScope.js";
import { GitCommitReviewPanel } from "./GitCommitReviewPanel.js";
import { selectCommitReviewGroup } from "./commitReviewModel.js";
import { GitPublishOptionsPanel, type PublishOptionsPanelProps } from "./GitPublishOptionsPanel.js";
import { GitPublishPreview, GitPublishResults } from "./GitPublishFeedback.js";
import type { PublishPlan } from "./publishModel.js";
import type { PublishRun } from "./publishExecution.js";

export interface GitCommitDialogProps {
  open: boolean;
  worktreeActions?: ReactNode;
  loading: boolean;
  state: GitCommitDialogState | null;
  workspacePath: string;
  message: string;
  previousMessage: string | null;
  error: string | null;
  mutationPending: boolean;
  generationPending: boolean;
  includeUnstaged: boolean;
  requiresRegeneration: boolean;
  reviewError: string | null;
  review: GitCommitReview | null;
  reviewPosition: number;
  browsePosition: number;
  expandedFiles: string[];
  excludedFiles: string[];
  reviewAcknowledged: boolean;
  reviewCanSubmit: boolean;
  publish: Omit<
    PublishOptionsPanelProps,
    "canCommit" | "remainingGroups" | "disabled" | "branchName"
  >;
  plan: PublishPlan | null;
  run: PublishRun | null;
  onReviewAcknowledge: (value: boolean) => void;
  onBrowse: (position: number) => void;
  onExpandedFilesChange: (paths: string[]) => void;
  onExclude: (path: string) => void;
  onRestoreFile: (path: string) => void;
  onManualFallback: () => void;
  onRefreshGit: () => void;
  onOpenChange: (open: boolean) => void;
  onMessageChange: (message: string) => void;
  onIncludeUnstagedChange: (value: boolean) => void;
  onGenerateMessage: () => void;
  onCopyMessage: () => void;
  onRestoreMessage: () => void;
  onSubmit: () => void;
  onVisible: () => void;
  onRetryLoad: () => void;
  onConfirmPublish: () => void;
  onCancelPreview: () => void;
  onRetryPublish: (id: string) => void;
  onResetPublish: () => void;
}

export function GitCommitDialog(props: GitCommitDialogProps) {
  const { intl, locale } = useLCodeIntl();
  const {
    state,
    review,
    reviewCanSubmit,
    reviewPosition,
    open,
    loading,
    mutationPending,
    generationPending,
  } = props;
  const dialogElementRef = useRef<HTMLDivElement>(null);
  const reportVisible = useCallback(() => {
    const element = dialogElementRef.current;
    if (!element?.isConnected) return;
    const style = getComputedStyle(element);
    if (
      element.getBoundingClientRect().width > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      Number(style.opacity) > 0
    )
      props.onVisible();
  }, [props.onVisible]);
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(reportVisible);
    return () => cancelAnimationFrame(frame);
  }, [open, reportVisible]);
  const actionPending = mutationPending || generationPending;
  const locked = actionPending || Boolean(props.plan || props.run);
  const hasIdentity = hasGitCommitIdentity(state?.identity ?? null);
  const selectedFiles = state
    ? getCommitDialogFiles(state, props.includeUnstaged, props.excludedFiles)
    : [];
  const stagePaths = state
    ? getCommitDialogStagePaths(state, props.includeUnstaged, props.excludedFiles)
    : [];
  const allFiles = state
    ? [
        ...new Map(
          getCommitDialogFiles(state, true).map((file) => [file.repoRelativePath, file]),
        ).values(),
      ]
    : [];
  const group = selectCommitReviewGroup(review, reviewPosition);
  const totals = getGitBranchCommitTotals(selectedFiles);
  const number = new Intl.NumberFormat(locale);
  const displayAdded = group
    ? group.files.reduce((sum, file) => sum + file.added, 0)
    : totals.totalAdded;
  const displayRemoved = group
    ? group.files.reduce((sum, file) => sum + file.removed, 0)
    : totals.totalRemoved;
  const commitActionDisabled =
    locked ||
    !reviewCanSubmit ||
    props.requiresRegeneration ||
    Boolean(review && props.browsePosition !== reviewPosition) ||
    !stagePaths.length ||
    (!hasIdentity && state?.identity !== null);
  const canCommit = !commitActionDisabled && hasIdentity && Boolean(props.message.trim());
  const remainingGroups = review ? review.groups.length - reviewPosition : 0;
  return (
    <Dialog open={open} onOpenChange={props.onOpenChange}>
      <DialogContent
        ref={dialogElementRef}
        onAnimationEnd={reportVisible}
        data-testid="git-commit-dialog"
        showCloseButton={false}
        className="max-h-[85dvh] w-[calc(100%-2rem)] max-w-md gap-0 overflow-y-auto overscroll-contain border-popover-border bg-popover p-0 shadow-lg [overflow-wrap:anywhere]"
        onOpenAutoFocus={(event) => {
          reportVisible();
          if (!loading && state) event.preventDefault();
        }}
      >
        <DialogTitle className="sr-only">
          {intl.formatMessage({ id: "git.actionMenu.commitDialog.title" })}
        </DialogTitle>
        <DialogDescription className="sr-only">
          {intl.formatMessage({
            id: review ? "git.review.frozen" : "git.actionMenu.commitDialog.description",
          })}
        </DialogDescription>
        {loading ? (
          <div className="flex h-56 items-center justify-center px-5 py-5 text-foreground-subtle">
            <LoaderIcon className="size-5 animate-spin" />
          </div>
        ) : state ? (
          <form
            className="min-w-0"
            onSubmit={(event) => {
              event.preventDefault();
              if (!commitActionDisabled) props.onSubmit();
            }}
            onKeyDownCapture={(event) => {
              if (!matchesPrimaryShortcut(event, "Enter")) return;
              // 快捷键只允许普通提交；发布选项、焦点与摘要不能把默认动作升级为网络发布。
              event.preventDefault();
              event.stopPropagation();
              if (!commitActionDisabled) props.onSubmit();
            }}
          >
            <div className="flex min-w-0 items-center justify-between gap-2 px-4 py-3">
              {locked ? (
                <span className="flex min-w-0 items-center gap-1 font-mono text-ui-sm">
                  <GitBranchIcon className="size-4 shrink-0" />
                  <span className="truncate">
                    {state.summary.branchName ?? intl.formatMessage({ id: "git.head.detached" })}
                  </span>
                </span>
              ) : (
                <GitBranchSwitcher
                  workspacePath={props.workspacePath}
                  gitSummary={state.summary}
                  dirtyFileCount={allFiles.length}
                  onRefreshGit={props.onRefreshGit}
                  className="min-w-0 px-0 pt-0"
                  triggerClassName="h-7 max-w-56 justify-start px-1.5 text-foreground-subtle [&>span]:max-w-40"
                  popoverSide="bottom"
                  popoverClassName="w-80 max-w-[calc(100vw-2rem)]"
                  branchListClassName="max-h-56"
                  showFooterActions={false}
                />
              )}
              <div className="flex shrink-0 gap-1.5 font-mono text-ui-sm">
                <span className="text-diff-added">+{number.format(displayAdded)}</span>
                <span className="text-diff-removed">−{number.format(displayRemoved)}</span>
              </div>
            </div>
            {props.worktreeActions}
            <GitCommitMessageEditor
              message={props.message}
              previousMessage={props.previousMessage}
              disabled={locked}
              generationPending={generationPending}
              canGenerate={stagePaths.length > 0 && hasIdentity}
              onMessageChange={props.onMessageChange}
              onGenerate={props.onGenerateMessage}
              onCopy={props.onCopyMessage}
              onRestore={props.onRestoreMessage}
            />
            {props.requiresRegeneration ? (
              <p role="alert" className="px-4 py-2 text-ui-sm text-warning">
                {intl.formatMessage({ id: "git.review.regenerationRequired" })}
              </p>
            ) : null}
            {props.reviewError ? (
              <div className="space-y-2 px-4 py-2 text-ui-sm" role="alert">
                <p className="break-words text-warning">{props.reviewError}</p>
                {!props.requiresRegeneration ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={locked}
                    onClick={props.onManualFallback}
                  >
                    {intl.formatMessage({ id: "git.review.manual" })}
                  </Button>
                ) : null}
              </div>
            ) : null}
            {review ? (
              <GitCommitReviewPanel
                review={review}
                position={reviewPosition}
                browsePosition={props.browsePosition}
                expandedFiles={props.expandedFiles}
                acknowledged={props.reviewAcknowledged}
                disabled={locked}
                onBrowse={props.onBrowse}
                onExpandedFilesChange={props.onExpandedFilesChange}
                onExclude={props.onExclude}
                onAcknowledge={props.onReviewAcknowledge}
                onManualFallback={props.onManualFallback}
              />
            ) : null}
            <GitCommitFileScope
              includeUnstaged={props.includeUnstaged}
              hasUnstaged={Boolean(state.unstagedFiles.length)}
              fileCount={stagePaths.length}
              files={allFiles}
              excludedFiles={props.excludedFiles}
              hasReview={Boolean(review)}
              disabled={locked}
              onIncludeUnstagedChange={props.onIncludeUnstagedChange}
              onExclude={props.onExclude}
              onRestoreFile={props.onRestoreFile}
            />
            {!hasIdentity ? (
              <p className="px-4 py-2 text-ui-sm text-warning">
                {intl.formatMessage({ id: "git.actionMenu.commitDialog.identityMissing" })}
              </p>
            ) : null}
            {props.error ? (
              <p
                role="alert"
                className="whitespace-pre-wrap break-words px-4 py-2 text-ui-sm text-destructive"
              >
                {props.error}
              </p>
            ) : null}
            <div className="border-t border-border px-2.5 py-2">
              <Command
                data-testid="git-commit-action-command"
                value="commit"
                shouldFilter={false}
                className="bg-transparent"
              >
                <CommandList className="max-h-none">
                  <CommandItem
                    value="commit"
                    data-testid="git-commit-action-item-commit"
                    disabled={commitActionDisabled}
                    onSelect={() => {
                      if (!commitActionDisabled) props.onSubmit();
                    }}
                    className="min-h-9"
                  >
                    {mutationPending ? (
                      <LoaderIcon className="size-4 animate-spin" />
                    ) : (
                      <GitCommitIcon className="size-4" />
                    )}
                    <span className="min-w-0 flex-1">
                      {intl.formatMessage({ id: "git.actionMenu.commitDialog.action.commit" })}
                    </span>
                    <CommandShortcut>{formatCommandShortcutLabel("⏎")}</CommandShortcut>
                  </CommandItem>
                </CommandList>
              </Command>
            </div>
            {!props.plan && !props.run ? (
              <GitPublishOptionsPanel
                {...props.publish}
                branchName={state.summary.branchName}
                disabled={actionPending}
                canCommit={canCommit}
                remainingGroups={remainingGroups}
              />
            ) : null}
            {props.plan && !props.run ? (
              <GitPublishPreview
                plan={props.plan}
                disabled={actionPending}
                onConfirm={props.onConfirmPublish}
                onCancel={props.onCancelPreview}
              />
            ) : null}
            {props.run ? (
              <GitPublishResults
                run={props.run}
                onRetry={props.onRetryPublish}
                onReset={props.onResetPublish}
              />
            ) : null}
            <div className="flex justify-end border-t border-border px-4 py-2">
              <Button
                type="button"
                variant="ghost"
                data-testid="git-commit-close"
                onClick={() => props.onOpenChange(false)}
              >
                {intl.formatMessage({ id: "common.close" })}
              </Button>
            </div>
          </form>
        ) : (
          <div className="space-y-4 px-4 py-5">
            <p role="alert" className="break-words text-ui-base text-destructive">
              {props.error}
            </p>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => props.onOpenChange(false)}>
                {intl.formatMessage({ id: "common.close" })}
              </Button>
              <Button type="button" onClick={props.onRetryLoad}>
                {intl.formatMessage({ id: "git.commitSummary.retry" })}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
