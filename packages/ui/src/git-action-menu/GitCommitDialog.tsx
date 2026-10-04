import { GitCommitLoadError } from "./GitCommitLoadError.js";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { GitCommitReview, SessionExecutionMode } from "@lcode/shared";
import type { WorktreeIntegration } from "@lcode/services";
import { LoaderIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog.js";
import { hasGitCommitIdentity } from "@/git-branch-switcher/switchAssist.js";
import { getGitBranchCommitTotals } from "@/git-branch-switcher/display.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { matchesPrimaryShortcut } from "@/lib/keyboardShortcuts.js";
import {
  getCommitDialogFiles,
  getCommitDialogStagePaths,
  type GitCommitDialogState,
} from "./commitDialogModel.js";
import { GitCommitExecutionSummary } from "./GitCommitExecutionSummary.js";
import { GitReviewStageNavigation } from "./GitReviewStageNavigation.js";
import { GitMergeReviewContent } from "./GitMergeReviewContent.js";
import { ReviewDialogDismiss } from "./ReviewDialogDismiss.js";
import { GitCommitMessageEditor } from "./GitCommitMessageEditor.js";
import { GitCommitFileScope } from "./GitCommitFileScope.js";
import { GitCommitReviewPanel } from "./GitCommitReviewPanel.js";
import { selectCommitReviewGroup } from "./commitReviewModel.js";
import { GitCommitConfirmAction } from "./GitCommitConfirmAction.js";
import { commitMergeState } from "./commitMergeState.js";
import { GitPublishOptionsPanel, type PublishOptionsPanelProps } from "./GitPublishOptionsPanel.js";
import { GitPublishPreview, GitPublishResults } from "./GitPublishFeedback.js";
import type { PublishPlan } from "./publishModel.js";
import type { PublishRun } from "./publishExecution.js";

export interface GitCommitDialogProps {
  open: boolean;
  failureAction?: ReactNode;
  worktreeActions?: ReactNode;
  worktreeMergeActions?: ReactNode;
  mergeOperationId?: string;
  mergeOperationStatus?: WorktreeIntegration["status"];
  mergeTargetBranch?: string;
  mergeView?: { operationId: string; source: boolean } | null;
  onMergeViewChange?: (value: { operationId: string; source: boolean } | null) => void;
  syncBlocked?: boolean;
  syncStatus?: ReactNode;
  onOpenFiles: (readOnly?: boolean) => void;
  onOpenScopeFiles: () => void;
  canOpenFiles: boolean;
  executionMode?: SessionExecutionMode;
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
  const { intl } = useLCodeIntl();
  const {
    state,
    review,
    reviewCanSubmit,
    reviewPosition,
    open,
    loading,
    mutationPending,
    generationPending,
    executionMode = "local",
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
  const [worktreeView, setWorktreeView] = useState<{ id: string; source: boolean } | null>(null);
  const [showPublicationPreview, setShowPublicationPreview] = useState(false);
  const { showMerge, sourceLocked } = commitMergeState(
    props.mergeOperationId && props.mergeOperationStatus
      ? { id: props.mergeOperationId, status: props.mergeOperationStatus }
      : undefined,
    props.onMergeViewChange
      ? props.mergeView
      : worktreeView
        ? { operationId: worktreeView.id, source: worktreeView.source }
        : null,
  );
  const actionPending = mutationPending || generationPending;
  const locked = actionPending || sourceLocked || Boolean(props.plan || props.run);
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
  const displayAdded = group
    ? group.files.reduce((sum, file) => sum + file.added, 0)
    : totals.totalAdded;
  const displayRemoved = group
    ? group.files.reduce((sum, file) => sum + file.removed, 0)
    : totals.totalRemoved;
  const commitActionDisabled =
    props.syncBlocked ||
    locked ||
    !reviewCanSubmit ||
    props.requiresRegeneration ||
    Boolean(review && props.browsePosition !== reviewPosition) ||
    !stagePaths.length ||
    (!hasIdentity && state?.identity !== null);
  const canCommit = !commitActionDisabled && hasIdentity && Boolean(props.message.trim());
  const workflowText = (field: string) =>
    intl.formatMessage({ id: `git.commitWorkflow.${executionMode}.${field}` });
  return (
    <Dialog open={open} onOpenChange={props.onOpenChange}>
      <DialogContent
        ref={dialogElementRef}
        onAnimationEnd={reportVisible}
        data-testid="git-commit-dialog"
        showCloseButton={false}
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        className="max-h-[85dvh] w-[calc(100%-2rem)] max-w-md gap-0 overflow-y-auto overscroll-contain border-popover-border bg-popover p-0 shadow-lg [overflow-wrap:anywhere]"
        onOpenAutoFocus={(event) => {
          reportVisible();
          if (!loading && state) event.preventDefault();
        }}
      >
        <ReviewDialogDismiss onClose={() => props.onOpenChange(false)} />
        <div className="border-b border-border px-4 py-3 pr-10">
          <DialogTitle className="text-ui-base" data-testid="git-commit-workflow-title">
            {workflowText("title")}
          </DialogTitle>
          <DialogDescription className="mt-1 text-ui-sm">
            {workflowText("description")}
          </DialogDescription>
        </div>
        {props.syncStatus}
        {loading ? (
          <div
            role="status"
            className="flex h-56 items-center justify-center gap-2 px-5 py-5 text-ui-sm text-foreground-subtle"
          >
            <LoaderIcon className="size-5 animate-spin" />
            {intl.formatMessage({ id: "git.commitWorkflow.loading" })}
          </div>
        ) : state ? (
          <form
            className="min-w-0"
            onSubmit={(event) => {
              event.preventDefault();
              if (!showMerge && !commitActionDisabled) props.onSubmit();
            }}
            onKeyDownCapture={(event) => {
              if (!matchesPrimaryShortcut(event, "Enter")) return;
              // 合并结果不属于来源提交表单；快捷键既不能提交隐藏的来源改动，也不能升级为网络发布。
              event.preventDefault();
              event.stopPropagation();
              if (!showMerge && !commitActionDisabled) props.onSubmit();
            }}
          >
            {/* 合并结果属于原项目目标目录；来源分支切换器只在来源提交视图展示，避免发布对象混淆。 */}
            {!showMerge ? (
              <GitCommitExecutionSummary
                workspacePath={props.workspacePath}
                executionMode={executionMode}
                summary={state.summary}
                locked={locked}
                fileCount={allFiles.length}
                added={displayAdded}
                removed={displayRemoved}
                onRefreshGit={props.onRefreshGit}
              />
            ) : null}
            {props.mergeOperationId ? (
              <GitReviewStageNavigation
                showMerge={showMerge}
                publishedTarget={
                  props.mergeOperationStatus === "published" ? props.mergeTargetBranch : undefined
                }
                disabled={Boolean(props.syncBlocked || actionPending || props.run?.running)}
                onBack={() =>
                  props.onMergeViewChange
                    ? props.onMergeViewChange({
                        operationId: props.mergeOperationId!,
                        source: showMerge,
                      })
                    : setWorktreeView({ id: props.mergeOperationId!, source: showMerge })
                }
              />
            ) : null}
            {!showMerge ? (
              <GitCommitFileScope
                includeUnstaged={props.includeUnstaged}
                hasUnstaged={Boolean(state.unstagedFiles.length)}
                fileCount={stagePaths.length}
                totalCount={allFiles.length}
                excludedCount={props.excludedFiles.length}
                onOpenFiles={() =>
                  sourceLocked ? props.onOpenFiles(true) : props.onOpenScopeFiles()
                }
                canOpenFiles={props.canOpenFiles}
                disabled={locked}
                readOnly={sourceLocked}
                onIncludeUnstagedChange={props.onIncludeUnstagedChange}
              />
            ) : null}
            {showMerge ? (
              <GitMergeReviewContent
                canOpenFiles={props.canOpenFiles}
                onOpenFiles={() => props.onOpenFiles(true)}
              >
                {props.worktreeMergeActions}
              </GitMergeReviewContent>
            ) : (
              <>
                {props.worktreeActions}
                <GitCommitMessageEditor
                  message={props.message}
                  previousMessage={props.previousMessage}
                  disabled={locked}
                  generationPending={generationPending}
                  canGenerate={!props.syncBlocked && stagePaths.length > 0 && hasIdentity}
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
                    acknowledged={props.reviewAcknowledged}
                    disabled={locked}
                    navigationDisabled={actionPending}
                    onBrowse={props.onBrowse}
                    onAcknowledge={props.onReviewAcknowledge}
                    onManualFallback={props.onManualFallback}
                    onOpenFiles={() => props.onOpenFiles(sourceLocked)}
                    canOpenFiles={props.canOpenFiles}
                  />
                ) : null}
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
                {props.failureAction}
                <GitCommitConfirmAction
                  disabled={commitActionDisabled}
                  pending={mutationPending}
                  label={workflowText("commit")}
                  onSubmit={props.onSubmit}
                />
                {!props.plan && !props.run ? (
                  <GitPublishOptionsPanel
                    {...props.publish}
                    contextDescription={
                      executionMode === "worktree" ? workflowText("publishHint") : undefined
                    }
                    branchName={state.summary.branchName}
                    disabled={actionPending}
                    canCommit={canCommit}
                    commitUnavailableHint={
                      !stagePaths.length
                        ? intl.formatMessage({ id: "git.publish.noCommitChanges" })
                        : undefined
                    }
                    remainingGroups={review ? review.groups.length - reviewPosition : 0}
                  />
                ) : null}
                {props.plan && (!props.run || showPublicationPreview) ? (
                  <GitPublishPreview
                    plan={props.plan}
                    disabled={actionPending}
                    onConfirm={props.onConfirmPublish}
                    onCancel={
                      props.run ? () => setShowPublicationPreview(false) : props.onCancelPreview
                    }
                    readOnly={Boolean(props.run)}
                  />
                ) : null}
                {props.run && !showPublicationPreview ? (
                  <GitPublishResults
                    run={props.run}
                    onRetry={props.onRetryPublish}
                    onReset={props.onResetPublish}
                    onBack={() => setShowPublicationPreview(true)}
                  />
                ) : null}
              </>
            )}
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
          <GitCommitLoadError
            error={props.error}
            failureAction={props.failureAction}
            onClose={() => props.onOpenChange(false)}
            onRetry={props.onRetryLoad}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
