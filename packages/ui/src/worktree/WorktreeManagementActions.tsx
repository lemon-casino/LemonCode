import { useState, type ReactNode } from "react";
import { useWorktreeTask } from "@/hooks/useWorktreeTask.js";
import { useOpenCommitReview } from "@/hooks/useCommitReviewNavigation.js";
import { useReviewDiffNavigation } from "@/hooks/useReviewDiffNavigation.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { WorktreeArchiveControl } from "./WorktreeArchiveControl.js";
import { WorktreeSnapshotSummary } from "./WorktreeIntegrationEvidence.js";
import { WorktreeReadStatus } from "./WorktreeReadStatus.js";
import { WorktreeReviewDialog } from "./WorktreeReviewDialog.js";
import { commitMergeState } from "@/git-action-menu/commitMergeState.js";
import { useWorktreeLifecycleStore } from "@/store/worktreeLifecycleStore.js";
import { useReviewWorkspaceState } from "@/hooks/useReviewWorkspaceState.js";

export function WorktreeManagementActions({
  workspacePath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  sessionId,
  busy,
  revision,
  renderContent,
  onHideReview,
  onShowReview,
  defaultOpen = false,
  onSelectSession,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  sessionId: string;
  busy: boolean;
  revision?: string;
  renderContent?: (content: ReactNode) => ReactNode;
  onHideReview?: () => void;
  onShowReview?: () => void;
  defaultOpen?: boolean;
  onSelectSession?: (sessionId: string) => void;
}) {
  const { intl } = useLCodeIntl();
  const lifecycleRevision = useWorktreeLifecycleStore(
    (state) => state.revisions[workspaceIdentity?.trim() || workspacePath] ?? 0,
  );
  const sharedReview = useReviewWorkspaceState(workspacePath, workspaceIdentity, sessionId);
  // 管理窗口隐藏后仍挂载；订阅原有失效/阶段版本，再读服务事实，避免合并后重开仍显示旧状态。
  const task = useWorktreeTask(
    workspacePath,
    workspaceIdentity,
    sessionId,
    `${revision ?? ""}/${lifecycleRevision}/${sharedReview.snapshot.fieldRevisions.integrationId}/${sharedReview.snapshot.fieldRevisions.worktreeView}`,
  );
  const [open, setOpen] = useState(defaultOpen);
  const [acknowledged, setAcknowledged] = useState(false);
  const hide = onHideReview ?? (() => setOpen(false));
  const navigation = useReviewDiffNavigation(
    JSON.stringify([workspaceIdentity?.trim() || workspacePath, sessionId, "management"]),
    hide,
    onShowReview ?? (() => setOpen(true)),
  );
  const openReview = useOpenCommitReview(
    workspacePath,
    workspaceIdentity,
    sessionId,
    onSelectSession,
  );
  const { binding, operation, worktreeService } = task;
  if (!binding || !worktreeService) {
    const content = (
      <WorktreeReadStatus loading={Boolean(renderContent) && task.loading} error={task.error} />
    );
    return renderContent ? renderContent(content) : content;
  }
  const locked =
    busy || task.pending || commitMergeState(operation ?? undefined, null).sourceLocked;
  const content = (
    <div className="space-y-3 text-ui-sm" data-testid="worktree-management-content">
      <p className="break-all font-mono">{binding.workspacePath}</p>
      <p className="break-all">{binding.branch}</p>
      <p>{intl.formatMessage({ id: `worktree.binding.${binding.status}` })}</p>
      <p className="text-foreground-subtle">
        {intl.formatMessage({ id: "worktree.managementDescription" })}
      </p>
      <Button
        type="button"
        variant="outline"
        data-testid="worktree-open-commit-review"
        disabled={task.pending || binding.status !== "ready"}
        onClick={() => {
          navigation.clearReturn();
          hide();
          openReview();
        }}
      >
        {intl.formatMessage({ id: "git.commitWorkflow.worktree.title" })}
      </Button>
      {operation ? (
        <p role="status">
          {intl.formatMessage(
            { id: `worktree.integration.${operation.status}` },
            { branch: operation.targetBranch },
          )}
        </p>
      ) : null}
      <WorktreeSnapshotSummary
        snapshot={binding.snapshot}
        onOpenFiles={
          navigation.available
            ? () =>
                navigation.openDiff({
                  type: "patch",
                  title: intl.formatMessage({ id: "worktree.openOmissions" }),
                  patch: "",
                  reviewFiles: binding.snapshot?.ignoredPaths.map((path) => ({ path, patch: "" })),
                  reviewMetadataOnly: true,
                  workspacePath: binding.workspacePath,
                  workspaceIdentity: binding.workspaceIdentity,
                  workspaceRemoteSessionId,
                })
            : undefined
        }
      />
      {binding.status === "archived" ? (
        <Button
          type="button"
          disabled={locked}
          onClick={() =>
            void task.perform(() =>
              worktreeService.restore({ bindingId: binding.id, requestId: crypto.randomUUID() }),
            )
          }
        >
          {intl.formatMessage({ id: "worktree.restore" })}
        </Button>
      ) : (
        <WorktreeArchiveControl
          disabled={locked}
          acknowledged={acknowledged}
          onChange={setAcknowledged}
          onArchive={() =>
            void task.perform(() =>
              worktreeService.archive({
                bindingId: binding.id,
                requestId: crypto.randomUUID(),
                acknowledgeIgnoredFiles: acknowledged,
              }),
            )
          }
        />
      )}
      <Button
        type="button"
        variant="ghost"
        disabled={task.pending}
        onClick={() => void task.refresh()}
      >
        {intl.formatMessage({ id: "worktree.refresh" })}
      </Button>
      <WorktreeReadStatus loading={task.pending} error={task.error} />
    </div>
  );
  if (renderContent) return renderContent(content);
  return (
    <WorktreeReviewDialog
      management
      binding={binding}
      targetBranch={binding.targetBranch}
      open={open}
      onOpenChange={setOpen}
      onManage={() => {
        setOpen(true);
        void task.refresh();
      }}
    >
      {content}
    </WorktreeReviewDialog>
  );
}
