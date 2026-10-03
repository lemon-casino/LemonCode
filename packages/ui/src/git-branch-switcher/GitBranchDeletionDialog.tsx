import type { GitLocalBranch } from "@lcode/shared";
import { Trash2Icon } from "lucide-react";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { useGitBranchDeletion } from "@/hooks/useGitBranchDeletion.js";
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

export function GitBranchDeleteButton({
  branch,
  disabled,
  onRequest,
}: {
  branch: GitLocalBranch;
  disabled?: boolean;
  onRequest: (branch: GitLocalBranch) => void;
}) {
  const { intl } = useLCodeIntl();
  const protectedBranch = branch.isCurrent || Boolean(branch.checkedOutPath);
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className="shrink-0 self-center"
      data-testid="git-branch-delete"
      data-branch-name={branch.name}
      aria-label={intl.formatMessage({ id: "git.branchDelete.action" }, { name: branch.name })}
      title={intl.formatMessage(
        { id: protectedBranch ? "git.branchDelete.inUse" : "git.branchDelete.action" },
        { name: branch.name },
      )}
      disabled={disabled || protectedBranch || !branch.commitHash}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onRequest(branch);
      }}
    >
      <Trash2Icon className="size-4" />
    </Button>
  );
}

export function GitBranchDeletionDialog({
  workspacePath,
  workspaceIdentity,
  branch,
  onClose,
  onDeleted,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  branch: GitLocalBranch | null;
  onClose: () => void;
  onDeleted: (name: string) => void;
}) {
  const { intl } = useLCodeIntl();
  const { pending, error, submit } = useGitBranchDeletion({
    workspacePath,
    workspaceIdentity,
    branch,
    onDeleted,
  });
  return (
    <AlertDialog
      open={branch !== null}
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <AlertDialogContent data-testid="git-branch-delete-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {intl.formatMessage({ id: "git.branchDelete.title" })}
          </AlertDialogTitle>
          <AlertDialogDescription className="break-words">
            {intl.formatMessage(
              { id: "git.branchDelete.description" },
              { name: branch?.name ?? "" },
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? (
          <p role="alert" className="text-ui-sm text-destructive">
            {error}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel asChild>
            <Button variant="outline" disabled={pending} onClick={onClose}>
              {intl.formatMessage({ id: "common.cancel" })}
            </Button>
          </AlertDialogCancel>
          <Button variant="destructive" disabled={pending} onClick={() => void submit()}>
            {intl.formatMessage({ id: pending ? "common.loading" : "git.branchDelete.confirm" })}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
