import { useProjectWorktrees } from "@/hooks/useProjectWorktrees.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { Trash2Icon } from "lucide-react";

export function ProjectWorktreeList({
  workspacePath,
  workspaceIdentity,
  enabled,
  onSelect,
  onDelete,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  enabled: boolean;
  onSelect: (sessionId: string) => void;
  onDelete?: (sessionId: string) => void;
}) {
  const { intl } = useLCodeIntl();
  const trees = useProjectWorktrees(workspacePath, workspaceIdentity, enabled);
  if (!trees.available) return null;
  return (
    <div className="mt-2 space-y-2" data-testid="project-worktree-list">
      <p className="text-foreground-subtle">
        {intl.formatMessage({ id: "worktree.projectWorktreesDescription" })}
      </p>
      {trees.loading ? <p role="status">{intl.formatMessage({ id: "worktree.loading" })}</p> : null}
      {trees.bindings.length ? (
        trees.bindings.map((binding) => (
          <div key={binding.id} className="min-w-0 rounded-md border border-border p-1">
            <p className="break-all px-2" title={binding.branch}>
              {binding.branch}
            </p>
            <p className="px-2 text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: `worktree.binding.${binding.status}` })}
            </p>
            <div className="flex items-center justify-between">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onSelect(binding.taskId)}
              >
                {intl.formatMessage({ id: "worktree.manage" })}
              </Button>
              {onDelete ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  data-testid="project-worktree-delete"
                  aria-label={intl.formatMessage({ id: "worktree.discard" })}
                  title={intl.formatMessage({ id: "worktree.discard" })}
                  onClick={() => onDelete(binding.taskId)}
                >
                  <Trash2Icon className="size-4" />
                </Button>
              ) : null}
            </div>
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
  );
}
