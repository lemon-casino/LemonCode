import type { GitLocalBranch } from "@lcode/shared";
import type { WorktreeBinding } from "@lcode/services";
import { Button } from "@/components/ui/button.js";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog.js";
import { useProjectWorktrees } from "@/hooks/useProjectWorktrees.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { findBranchWorktree } from "./branchOccupancy.js";

export function GitBranchInUseDialog({
  workspacePath,
  workspaceIdentity,
  branch,
  onClose,
  onManage,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  branch: GitLocalBranch;
  onClose: () => void;
  onManage: (binding: WorktreeBinding) => void;
}) {
  const { intl } = useLCodeIntl();
  const trees = useProjectWorktrees(
    workspacePath,
    workspaceIdentity,
    Boolean(branch.checkedOutPath),
  );
  const binding =
    !trees.loading && !trees.error
      ? findBranchWorktree(trees.bindings, branch.name, branch.checkedOutPath)
      : undefined;
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <AlertDialogContent
        data-testid="git-branch-in-use-dialog"
        className="max-h-[85dvh] overflow-y-auto"
      >
        <AlertDialogHeader>
          <AlertDialogTitle>
            {intl.formatMessage({ id: "git.branchDelete.inUseTitle" })}
          </AlertDialogTitle>
          <AlertDialogDescription className="break-all">
            {intl.formatMessage(
              {
                id: branch.isCurrent
                  ? "git.branchDelete.currentDescription"
                  : "git.branchDelete.occupiedDescription",
              },
              { name: branch.name },
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {branch.checkedOutPath ? (
          <div className="space-y-1">
            <p className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "git.branchDelete.checkoutPath" })}
            </p>
            <p className="break-all font-mono text-ui-sm">{branch.checkedOutPath}</p>
          </div>
        ) : null}
        {trees.loading ? (
          <p role="status">{intl.formatMessage({ id: "worktree.loading" })}</p>
        ) : null}
        {trees.error ? (
          <p role="alert" className="break-all text-ui-sm text-destructive">
            {trees.error}
          </p>
        ) : null}
        {binding ? (
          <p className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "git.branchDelete.managedDescription" })}
          </p>
        ) : branch.checkedOutPath && !branch.isCurrent && !trees.loading && !trees.error ? (
          <p
            data-testid="git-branch-external-worktree"
            className="text-ui-sm text-foreground-subtle"
          >
            {intl.formatMessage({
              id: trees.available
                ? "git.branchDelete.externalDescription"
                : "git.branchDelete.managementUnavailable",
            })}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel asChild>
            <Button variant="outline" onClick={onClose}>
              {intl.formatMessage({ id: "common.close" })}
            </Button>
          </AlertDialogCancel>
          {trees.error ? (
            <Button variant="outline" onClick={() => void trees.refresh()}>
              {intl.formatMessage({ id: "worktree.refresh" })}
            </Button>
          ) : null}
          {binding ? (
            <Button data-testid="git-branch-open-worktree" onClick={() => onManage(binding)}>
              {intl.formatMessage({ id: "worktree.manage" })}
            </Button>
          ) : null}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
