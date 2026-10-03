import { useState, useEffect, type ReactNode } from "react";
import { LoaderIcon } from "lucide-react";
import { useProjectExecutionPolicy } from "@/hooks/useProjectExecutionPolicy.js";
import { useWorktreeTask } from "@/hooks/useWorktreeTask.js";
import { useReviewDiffNavigation } from "@/hooks/useReviewDiffNavigation.js";
import { useReviewWorkspaceState } from "@/hooks/useReviewWorkspaceState.js";
import { useWorktreeReviewStage } from "@/hooks/useWorktreeReviewStage.js";
import { ReviewWorkspaceSyncStatus } from "@/git-action-menu/ReviewWorkspaceSyncStatus.js";
import { WorktreeValidationResults } from "./WorktreeValidationResults.js";
import { WorktreeReadStatus } from "./WorktreeReadStatus.js";
import { LiveWorktreePreparationCard } from "./WorktreePreparationCard.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { WorktreeCandidateApproval } from "./WorktreeCandidateApproval.js";
import { WorktreeReviewDialog } from "./WorktreeReviewDialog.js";
import { WorktreeArchiveControl } from "./WorktreeArchiveControl.js";
import { WorktreePreparation } from "./WorktreePreparation.js";
import { WorktreeReviewStageNavigation } from "./WorktreeReviewStageNavigation.js";
import { WorktreePublication } from "./WorktreePublication.js";
import {
  WorktreeIntegrationEvidence,
  WorktreeSnapshotSummary,
} from "./WorktreeIntegrationEvidence.js";
import { integrationReviewFiles } from "./worktreeReviewStages.js";

export function WorktreeTaskActions({
  workspacePath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  sessionId,
  busy,
  revision,
  onResolveConflicts,
  defaultOpen = false,
  renderContent,
  onHideReview,
  onShowReview,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  sessionId: string;
  busy: boolean;
  revision?: string;
  defaultOpen?: boolean;
  onResolveConflicts?: (operationId: string) => Promise<void>;
  renderContent?: (content: ReactNode) => ReactNode;
  onHideReview?: () => void;
  onShowReview?: () => void;
}) {
  const { intl } = useLCodeIntl();
  const { policy } = useProjectExecutionPolicy(workspacePath, workspaceIdentity);
  const sharedReview = useReviewWorkspaceState(workspacePath, workspaceIdentity, sessionId);
  const task = useWorktreeTask(
    workspacePath,
    workspaceIdentity,
    sessionId,
    `${revision ?? ""}/${sharedReview.snapshot.fieldRevisions.integrationId}/${sharedReview.snapshot.fieldRevisions.worktreeView}`,
  );
  const { binding, operation, pending, worktreeService } = task;
  const [open, setOpen] = useState(defaultOpen);
  const commands = sharedReview.data.validationCommands;
  const [approvedHead, setApprovedHead] = useState<string | null>(null);
  const [skipValidation, setSkipValidation] = useState(false);
  const [acknowledgeIgnoredFiles, setAcknowledgeIgnoredFiles] = useState(false);
  const { stage, currentStage, phaseKey, readOnly, setView } = useWorktreeReviewStage(
    sharedReview,
    binding,
    operation,
    task.loading,
  );
  useEffect(() => {
    setApprovedHead(null);
  }, [sharedReview.data.targetBranch, commands, operation?.candidateHead]);
  const diffNavigation = useReviewDiffNavigation(
    JSON.stringify([workspaceIdentity?.trim() || workspacePath, sessionId]),
    onHideReview ?? (() => setOpen(false)),
    onShowReview ?? (() => setOpen(true)),
  );
  if (!binding || !worktreeService) {
    const { error, loading } = task;
    const status = <WorktreeReadStatus error={error} loading={Boolean(renderContent) && loading} />;
    // 嵌入项目管理窗口时，首次读取绑定尚未完成也保留外壳与返回入口，避免选择条目后窗口短暂消失。
    return renderContent ? renderContent(status) : status;
  }
  const locked = busy || pending || readOnly || sharedReview.status !== "ready";
  const text = (key: string) => intl.formatMessage({ id: `worktree.${key}` });
  const activeIntegration = Boolean(
    operation &&
    !["published", "failed", "cancelled", "source-commit-failed"].includes(operation.status),
  );
  const targetBranch =
    (activeIntegration ? operation?.targetBranch : sharedReview.data.targetBranch) ??
    operation?.targetBranch ??
    binding.targetBranch;
  const validationCommands = (commands ?? policy.validationCommands.join("\n"))
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const canPublish =
    (operation?.status === "ready" || operation?.status === "publishing") &&
    operation.candidateHead &&
    approvedHead === operation.candidateHead &&
    (operation.validationCommands.length > 0 || skipValidation);
  const integrate = () =>
    task.perform(async () => {
      const capability = await worktreeService.getCapabilities({
        workspacePath: binding.workspacePath,
        workspaceIdentity: binding.workspaceIdentity,
      });
      if (!capability.head) throw new Error(text("sourceUnavailable"));
      await worktreeService.integrate({
        requestId: crypto.randomUUID(),
        bindingId: binding.id,
        expectedSourceHead: capability.head,
        targetBranch,
        validationCommands: validationCommands.length ? validationCommands : undefined,
      });
    });
  const content = (
    <div className="min-w-0 space-y-3">
      {renderContent && binding.preparation ? (
        <LiveWorktreePreparationCard binding={binding} onSettled={task.refresh} />
      ) : null}
      <ReviewWorkspaceSyncStatus
        status={sharedReview.status}
        onRetry={() => void sharedReview.retry()}
        onResolve={sharedReview.resolve}
      />
      <WorktreeReviewStageNavigation
        stage={stage}
        currentStage={currentStage}
        onStage={(index) => setView({ key: phaseKey, stage: index })}
        onCurrent={() => setView(null)}
      />
      <p className="text-ui-sm text-foreground-subtle">{text(`binding.${binding.status}`)}</p>
      {stage === 0 ? (
        <WorktreePreparation
          binding={binding}
          targetBranch={targetBranch}
          commands={commands ?? policy.validationCommands.join("\n")}
          locked={locked}
          activeIntegration={activeIntegration}
          onTarget={(branch) => {
            sharedReview.patch({ targetBranch: branch });
            setApprovedHead(null);
          }}
          onRestore={() =>
            void task.perform(() =>
              worktreeService.restore({ bindingId: binding.id, requestId: crypto.randomUUID() }),
            )
          }
          onIntegrate={() => void integrate()}
        />
      ) : null}
      {operation &&
      (stage > 0 || ["cancelled", "failed", "source-commit-failed"].includes(operation.status)) ? (
        <div
          className="min-w-0 space-y-3 rounded-lg border border-border p-3"
          data-testid="worktree-integration-status"
        >
          <WorktreeIntegrationEvidence
            operation={operation}
            workspaceIdentity={binding.originalWorkspaceIdentity}
          />
          {operation.status === "conflicted" ? (
            <>
              <p className="text-ui-sm text-foreground-subtle">{text("conflictInstructions")}</p>
              {onResolveConflicts ? (
                <Button
                  type="button"
                  disabled={locked}
                  onClick={() => void task.perform(() => onResolveConflicts(operation.id))}
                >
                  {text("resolveWithAI")}
                </Button>
              ) : null}
              <Button
                type="button"
                variant="outline"
                disabled={locked}
                onClick={() =>
                  void task.perform(() =>
                    worktreeService.continueIntegration({ operationId: operation.id }),
                  )
                }
              >
                {text("continue")}
              </Button>
            </>
          ) : null}
          {operation.diff || operation.conflictPaths.length ? (
            <Button
              type="button"
              variant="outline"
              data-testid="worktree-open-diff"
              disabled={!diffNavigation.available}
              onClick={() =>
                diffNavigation.openDiff({
                  type: "patch",
                  title: text("reviewDiff"),
                  patch: "",
                  reviewFiles: operation.diff
                    ? integrationReviewFiles(
                        operation.diff,
                        operation.checkoutPath,
                        operation.conflictPaths,
                      )
                    : operation.conflictPaths.map((path) => ({ path })),
                  workspacePath: operation.checkoutPath,
                  workspaceIdentity: binding.originalWorkspaceIdentity,
                  workspaceRemoteSessionId,
                })
              }
            >
              {text("reviewDiff")}
            </Button>
          ) : null}
          <WorktreeValidationResults
            results={operation.validationResults}
            commands={operation.validationCommands}
          />
          <WorktreeCandidateApproval
            operation={operation}
            locked={locked}
            approvedHead={approvedHead}
            skipValidation={skipValidation}
            canPublish={Boolean(canPublish)}
            onApprove={setApprovedHead}
            onSkip={setSkipValidation}
            onValidate={() =>
              void task.perform(() =>
                worktreeService.continueIntegration({
                  operationId: operation.id,
                  approvedCandidateHead: operation.candidateHead,
                }),
              )
            }
            onPublish={() =>
              void task.perform(() =>
                worktreeService.publishIntegration({
                  operationId: operation.id,
                  approvedCandidateHead: operation.candidateHead!,
                }),
              )
            }
          />
          {operation.error ? (
            <p role="alert" className="break-words text-ui-sm text-destructive">
              {operation.error}
            </p>
          ) : null}
          {!["publishing", "published", "cancelled"].includes(operation.status) ? (
            <Button
              type="button"
              variant="outline"
              disabled={locked}
              data-testid="worktree-cancel-integration"
              onClick={() =>
                void task.perform(() =>
                  worktreeService.continueIntegration({ operationId: operation.id, cancel: true }),
                )
              }
            >
              {text("cancelIntegration")}
            </Button>
          ) : null}
        </div>
      ) : null}
      <WorktreeSnapshotSummary
        snapshot={binding.snapshot}
        onOpenFiles={
          diffNavigation.available
            ? () =>
                diffNavigation.openDiff({
                  type: "patch",
                  title: text("openOmissions"),
                  patch: "",
                  reviewFiles: binding.snapshot?.ignoredPaths.map((path) => ({ path, patch: "" })),
                  reviewMetadataOnly: true,
                  workspacePath: binding.workspacePath,
                  workspaceIdentity: binding.originalWorkspaceIdentity,
                  workspaceRemoteSessionId,
                })
            : undefined
        }
      />
      {binding.status !== "archived" && !readOnly ? (
        <WorktreeArchiveControl
          disabled={locked}
          acknowledged={acknowledgeIgnoredFiles}
          onChange={setAcknowledgeIgnoredFiles}
          onArchive={() =>
            void task.perform(() =>
              worktreeService.archive({
                bindingId: binding.id,
                requestId: crypto.randomUUID(),
                acknowledgeIgnoredFiles,
              }),
            )
          }
        />
      ) : null}
      <Button type="button" variant="ghost" disabled={pending} onClick={() => void task.refresh()}>
        {text("refresh")}
      </Button>
      {pending ? (
        <span role="status" className="flex items-center gap-2 text-ui-sm">
          <LoaderIcon className="size-4 animate-spin" />
          {text("working")}
        </span>
      ) : null}
      {task.error ? (
        <p role="alert" className="break-words text-ui-sm text-destructive">
          {task.error}
        </p>
      ) : null}
    </div>
  );
  // 控制器位于模态内容之上：隐藏窗口不会卸载发布执行器或清空确认状态。
  const renderReview = (publication?: ReactNode) => {
    const reviewContent = (
      <>
        {content}
        {!readOnly ? publication : null}
      </>
    );
    if (renderContent) return renderContent(reviewContent);
    return (
      <WorktreeReviewDialog
        binding={binding}
        targetBranch={targetBranch}
        open={open}
        onOpenChange={setOpen}
        onManage={() => {
          diffNavigation.clearReturn();
          setOpen(true);
          void task.refresh();
        }}
      >
        {reviewContent}
      </WorktreeReviewDialog>
    );
  };
  return operation?.status === "published" ? (
    <WorktreePublication
      key={operation.id}
      operation={operation}
      workspaceIdentity={binding.originalWorkspaceIdentity}
      disabled={locked}
      renderReview={renderReview}
    />
  ) : (
    renderReview()
  );
}
