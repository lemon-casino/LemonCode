import { useState } from "react";
import { useProjectWorktrees } from "@/hooks/useProjectWorktrees.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { WorktreeTaskActions } from "./WorktreeTaskActions.js";

export function ProjectWorktreeList({
  workspacePath,
  workspaceIdentity,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
}) {
  const { intl } = useLCodeIntl();
  const [open, setOpen] = useState(false);
  const trees = useProjectWorktrees(workspacePath, workspaceIdentity, open);
  if (!trees.available) return null;
  return (
    <details
      className="border-t border-border pt-2 text-ui-sm"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer">
        {intl.formatMessage({ id: "worktree.projectWorktrees" })}
      </summary>
      {open ? (
        <div className="mt-2 space-y-2" data-testid="project-worktree-list">
          <p className="text-foreground-subtle">
            {intl.formatMessage({ id: "worktree.projectWorktreesDescription" })}
          </p>
          {trees.loading ? (
            <p role="status">{intl.formatMessage({ id: "worktree.loading" })}</p>
          ) : null}
          {trees.bindings.length ? (
            trees.bindings.map((binding) => (
              <div key={binding.id} className="min-w-0 rounded-md border border-border p-1">
                <p className="truncate px-2" title={binding.branch}>
                  {binding.branch}
                </p>
                <WorktreeTaskActions
                  workspacePath={workspacePath}
                  workspaceIdentity={workspaceIdentity}
                  sessionId={binding.taskId}
                  busy={false}
                />
              </div>
            ))
          ) : !trees.loading ? (
            <p>{intl.formatMessage({ id: "worktree.noWorktrees" })}</p>
          ) : null}
          {trees.error ? (
            <p role="alert" className="break-words text-destructive">
              {trees.error}
            </p>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={trees.loading}
            onClick={() => void trees.refresh()}
          >
            {intl.formatMessage({ id: "worktree.refresh" })}
          </Button>
        </div>
      ) : null}
    </details>
  );
}
