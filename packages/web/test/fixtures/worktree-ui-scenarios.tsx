import { useState } from "react";
import type { WorktreeIntegration } from "@lcode/services";
import type { GitCommitReview } from "@lcode/shared";
import { CommitAndMergeControl } from "@/worktree/CommitAndMergeControl.js";
import { WorktreeTaskActions } from "@/worktree/WorktreeTaskActions.js";
import { WorktreeManagementActions } from "@/worktree/WorktreeManagementActions.js";

export function WorktreeWorkflowScenario({
  mode,
  onResolve,
}: {
  mode: string;
  onResolve: (operationId: string) => Promise<void>;
}) {
  const [message, setMessage] = useState("edited first message");
  const [committed, setCommitted] = useState(false);
  const review: GitCommitReview = {
    id: "review",
    mode: "ordered",
    warnings: [],
    groups: ["A", "B"].map((id) => ({
      id,
      sessionIds: ["orphan"],
      label: id,
      dependsOn: [],
      message: `message ${id}`,
      requiresConfirmation: true,
      files: [],
    })),
  };
  return (
    <main className="w-full max-w-3xl space-y-3 p-4">
      {mode === "commit" ? (
        <>
          <label>
            Message
            <input
              data-testid="scenario-message"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
            />
          </label>
          <output data-testid="scenario-committed">{String(committed)}</output>
          <CommitAndMergeControl
            workspacePath="/fixture/worktrees/task"
            originWorkspacePath="/fixture/repo"
            sessionId="orphan"
            review={committed ? null : review}
            position={0}
            currentMessage={message}
            disabled={false}
            onCommitted={(operation: WorktreeIntegration) =>
              setCommitted(Boolean(operation.sourceReceipts?.length))
            }
          />
        </>
      ) : mode === "management" ? (
        <WorktreeManagementActions
          workspacePath="/fixture/repo"
          sessionId="orphan"
          busy={false}
          defaultOpen
        />
      ) : (
        <WorktreeTaskActions
          workspacePath="/fixture/repo"
          sessionId="orphan"
          busy={false}
          defaultOpen
          onResolveConflicts={onResolve}
        />
      )}
    </main>
  );
}
