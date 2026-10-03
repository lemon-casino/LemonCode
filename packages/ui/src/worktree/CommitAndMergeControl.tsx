import { useRef, useState } from "react";
import type { GitCommitRequest, GitCommitReview } from "@lcode/shared";
import type { WorktreeIntegration, WorktreeIntegrateRequest } from "@lcode/services";
import { useProjectExecutionPolicy } from "@/hooks/useProjectExecutionPolicy.js";
import { useWorktreeTask } from "@/hooks/useWorktreeTask.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { WorktreeTaskActions } from "./WorktreeTaskActions.js";
import { WorktreeTargetSelect } from "./WorktreeTargetSelect.js";

export function CommitAndMergeControl({
  workspacePath,
  workspaceIdentity,
  originWorkspacePath,
  originWorkspaceIdentity,
  sessionId,
  review,
  position,
  currentMessage,
  disabled,
  onCommitted,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  originWorkspacePath: string;
  originWorkspaceIdentity?: string;
  sessionId: string;
  review: GitCommitReview | null;
  position: number;
  currentMessage: string;
  disabled: boolean;
  onCommitted: (operation: WorktreeIntegration) => void;
}) {
  const { intl } = useLCodeIntl();
  const { policy } = useProjectExecutionPolicy(originWorkspacePath, originWorkspaceIdentity);
  const task = useWorktreeTask(originWorkspacePath, originWorkspaceIdentity, sessionId);
  const { binding, worktreeService } = task;
  const [approvedReview, setApprovedReview] = useState<string | null>(null);
  const [completed, setCompleted] = useState(false);
  const [target, setTarget] = useState<{ bindingId: string; branch: string } | null>(null);
  const request = useRef<{ key: string; params: WorktreeIntegrateRequest } | null>(null);
  const remaining = review?.groups.slice(position) ?? [];
  if (!binding || !worktreeService) return null;
  const targetBranch = target?.bindingId === binding.id ? target.branch : binding.targetBranch;
  const reviewKey = JSON.stringify([review?.id, position, currentMessage, targetBranch]);
  const submit = () =>
    task.perform(async () => {
      if (!review || approvedReview !== reviewKey || !remaining.length) return;
      if (request.current?.key !== reviewKey) {
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
            validationCommands: policy.validationCommands,
            sourceCommits,
          },
        };
      }
      const operation = await worktreeService.integrate(request.current.params);
      onCommitted(operation);
      setCompleted(true);
    });
  return (
    <div
      className="space-y-2 border-t border-border px-4 py-3"
      data-testid="commit-and-merge-control"
    >
      <p className="break-all text-ui-sm">
        {binding.branch} → {targetBranch}
      </p>
      {review && remaining.length ? (
        <>
          <WorktreeTargetSelect
            workspacePath={originWorkspacePath}
            workspaceIdentity={originWorkspaceIdentity}
            value={targetBranch}
            onChange={(branch) => {
              setTarget({ bindingId: binding.id, branch });
              setApprovedReview(null);
            }}
            disabled={disabled || task.pending}
          />
          <label className="flex items-start gap-2 text-ui-sm">
            <Checkbox
              disabled={disabled || task.pending}
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
              disabled || task.pending || approvedReview !== reviewKey || !currentMessage.trim()
            }
            onClick={() => void submit()}
          >
            {intl.formatMessage({ id: "worktree.commitAndMerge" }, { branch: targetBranch })}
          </Button>
        </>
      ) : null}
      {task.error ? (
        <p role="alert" className="text-ui-sm text-destructive">
          {task.error}
        </p>
      ) : null}
      <WorktreeTaskActions
        key={completed ? "completed" : "initial"}
        workspacePath={originWorkspacePath}
        workspaceIdentity={originWorkspaceIdentity}
        sessionId={sessionId}
        busy={disabled || task.pending}
        defaultOpen={completed}
      />
    </div>
  );
}
