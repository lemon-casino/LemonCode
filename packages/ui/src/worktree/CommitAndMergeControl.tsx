import { useRef, useState, type ReactNode } from "react";
import type { GitCommitRequest, GitCommitReview } from "@lcode/shared";
import type { WorktreeIntegration, WorktreeIntegrateRequest } from "@lcode/services";
import { useProjectExecutionPolicy } from "@/hooks/useProjectExecutionPolicy.js";
import { useWorktreeTask } from "@/hooks/useWorktreeTask.js";
import { useReviewWorkspaceState } from "@/hooks/useReviewWorkspaceState.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { WorktreeTaskActions } from "./WorktreeTaskActions.js";
import { WorktreeTargetSelect } from "./WorktreeTargetSelect.js";
import { commitMergeState } from "@/git-action-menu/commitMergeState.js";

export function CommitAndMergeControl({
  workspacePath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  renderDialog,
  onHideReview,
  onShowReview,
  onResolveConflicts,
  originWorkspacePath,
  originWorkspaceIdentity,
  sessionId,
  reviewRevision,
  review,
  position,
  currentMessage,
  disabled,
  onCommitted,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  renderDialog?: (
    prepare: ReactNode,
    merge: ReactNode,
    operation?: WorktreeIntegration | null,
  ) => ReactNode;
  onHideReview?: () => void;
  onShowReview?: () => void;
  onResolveConflicts?: (operationId: string) => Promise<void>;
  originWorkspacePath: string;
  originWorkspaceIdentity?: string;
  sessionId: string;
  reviewRevision?: string;
  review: GitCommitReview | null;
  position: number;
  currentMessage: string;
  disabled: boolean;
  onCommitted: (operation: WorktreeIntegration) => void;
}) {
  const { intl } = useLCodeIntl();
  const { policy } = useProjectExecutionPolicy(originWorkspacePath, originWorkspaceIdentity);
  const sharedReview = useReviewWorkspaceState(
    originWorkspacePath,
    originWorkspaceIdentity,
    sessionId,
  );
  const task = useWorktreeTask(
    originWorkspacePath,
    originWorkspaceIdentity,
    sessionId,
    `${sharedReview.snapshot.fieldRevisions.integrationId}/${reviewRevision ?? ""}`,
  );
  const { binding, worktreeService } = task;
  const sourceLocked = commitMergeState(task.operation ?? undefined, null).sourceLocked;
  const [approvedReview, setApprovedReview] = useState<string | null>(null);
  const [completed, setCompleted] = useState(false);
  const request = useRef<{ key: string; params: WorktreeIntegrateRequest } | null>(null);
  const remaining = review?.groups.slice(position) ?? [];
  if (!binding || !worktreeService) return null;
  // 历史操作只供回看，不能覆盖新审核所选目标分支；活动操作才冻结其目标。
  const targetBranch =
    (sourceLocked ? task.operation?.targetBranch : undefined) ??
    sharedReview.data.targetBranch ??
    binding.targetBranch;
  const reviewKey = JSON.stringify([review?.id, position, currentMessage, targetBranch]);
  const submit = () =>
    task.perform(async () => {
      if (
        sharedReview.read().status !== "ready" ||
        !review ||
        approvedReview !== reviewKey ||
        !remaining.length
      )
        return;
      const discardedRequest =
        task.operation &&
        ["cancelled", "failed"].includes(task.operation.status) &&
        task.operation.requestId === request.current?.params.requestId;
      if (request.current?.key !== reviewKey || discardedRequest) {
        const state = await task.gitService.getPublishState({ workspacePath, workspaceIdentity });
        if (!state.headCommitHash)
          throw new Error(intl.formatMessage({ id: "worktree.sourceUnavailable" }));
        const sourceCommits: GitCommitRequest[] = remaining.map((group, index) => ({
          workspacePath,
          workspaceIdentity,
          message: index === 0 ? currentMessage : group.message,
          review: { id: review.id, groupId: group.id, acknowledged: true },
        }));
        request.current = {
          key: reviewKey,
          params: {
            requestId: crypto.randomUUID(),
            bindingId: binding.id,
            expectedSourceHead: state.headCommitHash,
            targetBranch,
            validationCommands: policy.validationCommands.length
              ? policy.validationCommands
              : undefined,
            sourceCommits,
          },
        };
      }
      const operation = await worktreeService.integrate(request.current.params);
      sharedReview.patch({ integrationId: operation.id, mergeView: null });
      onCommitted(operation);
      setCompleted(true);
    });
  const preparation = (mergePreparation?: ReactNode) => (
    <div
      className="space-y-2 border-t border-border px-4 py-3"
      data-testid="commit-and-merge-control"
    >
      <p className="break-all text-ui-sm">
        {intl.formatMessage(
          { id: "worktree.sourceToTarget" },
          { source: binding.branch, target: targetBranch },
        )}
      </p>
      {review && remaining.length ? (
        <p className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "worktree.prepareMergeHint" })}
        </p>
      ) : null}
      {review && remaining.length ? (
        <>
          <WorktreeTargetSelect
            workspacePath={originWorkspacePath}
            workspaceIdentity={originWorkspaceIdentity}
            value={targetBranch}
            onChange={(branch) => {
              sharedReview.patch({ targetBranch: branch });
              setApprovedReview(null);
            }}
            disabled={disabled || sourceLocked || task.pending || sharedReview.status !== "ready"}
          />
          <label className="flex items-start gap-2 text-ui-sm">
            <Checkbox
              disabled={disabled || sourceLocked || task.pending}
              checked={approvedReview === reviewKey}
              onCheckedChange={(value) => setApprovedReview(value === true ? reviewKey : null)}
            />
            <span>
              {intl.formatMessage(
                { id: "worktree.approveRemainingGroups" },
                { count: remaining.length },
              )}
            </span>
          </label>
          <Button
            type="button"
            data-testid="git-commit-and-merge"
            disabled={
              disabled ||
              sourceLocked ||
              task.pending ||
              approvedReview !== reviewKey ||
              !currentMessage.trim()
            }
            onClick={() => void submit()}
          >
            {intl.formatMessage({ id: "worktree.commitAndMerge" }, { branch: targetBranch })}
          </Button>
        </>
      ) : (
        mergePreparation
      )}
      {task.error ? (
        <p role="alert" className="text-ui-sm text-destructive">
          {task.error}
        </p>
      ) : null}
    </div>
  );
  const worktreeProps = {
    workspacePath: originWorkspacePath,
    workspaceIdentity: originWorkspaceIdentity,
    workspaceRemoteSessionId,
    sessionId,
    busy: disabled || task.pending,
    onHideReview,
    onShowReview,
    onResolveConflicts,
    revision: task.operation ? `${task.operation.id}/${task.operation.status}` : undefined,
  };
  if (renderDialog)
    return (
      <WorktreeTaskActions
        {...worktreeProps}
        renderContent={(content, mergePreparation) =>
          renderDialog(preparation(mergePreparation), content, task.operation)
        }
      />
    );
  return (
    <>
      {preparation()}
      <WorktreeTaskActions
        {...worktreeProps}
        key={completed ? "completed" : "initial"}
        defaultOpen={completed}
      />
    </>
  );
}
