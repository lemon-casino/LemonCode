import { useState } from "react";
import type { GitLocalBranch } from "@lcode/shared";
import { InfoIcon, Trash2Icon } from "lucide-react";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { useGitBranchDeletion } from "@/hooks/useGitBranchDeletion.js";
import { Button } from "@/components/ui/button.js";
import { ProjectWorktreeManagementDialog } from "@/worktree/ProjectWorktreeManagementDialog.js";
import { GitBranchInUseDialog } from "./GitBranchInUseDialog.js";
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
      data-branch-action={protectedBranch ? "in-use" : "delete"}
      aria-label={intl.formatMessage(
        { id: protectedBranch ? "git.branchDelete.inspect" : "git.branchDelete.action" },
        { name: branch.name },
      )}
      title={intl.formatMessage(
        { id: protectedBranch ? "git.branchDelete.inUse" : "git.branchDelete.action" },
        { name: branch.name },
      )}
      disabled={disabled || (!protectedBranch && !branch.commitHash)}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onRequest(branch);
      }}
    >
      {protectedBranch ? (
        <InfoIcon className="size-4 text-foreground-subtle" />
      ) : (
        <Trash2Icon className="size-4" />
      )}
    </Button>
  );
}

export function GitBranchDeletionDialog({
  workspacePath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  branch,
  onClose,
  onDeleted,
  onRefresh,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  branch: GitLocalBranch | null;
  onClose: () => void;
  onDeleted: (name: string) => void;
  onRefresh?: () => void;
}) {
  const { intl } = useLCodeIntl();
  const [management, setManagement] = useState<{
    taskId: string;
    open: boolean;
    workspacePath: string;
    workspaceIdentity?: string;
  } | null>(null);
  const protectedBranch = branch && (branch.isCurrent || branch.checkedOutPath);
  const { pending, error, submit } = useGitBranchDeletion({
    workspacePath,
    workspaceIdentity,
    branch,
    onDeleted,
  });
  return (
    <>
      {protectedBranch && branch ? (
        <GitBranchInUseDialog
          key={branch.name}
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          branch={branch}
          onClose={onClose}
          onManage={(binding) => {
            // 占用事实由登记绑定确认；先关闭说明窗口，再沿原项目 owner 打开既有管理，不执行清理。
            onClose();
            setManagement({
              taskId: binding.taskId,
              open: true,
              workspacePath: binding.originalWorkspacePath,
              workspaceIdentity: binding.originalWorkspaceIdentity,
            });
          }}
        />
      ) : null}
      <AlertDialog
        open={branch !== null && !protectedBranch}
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
      {management ? (
        <ProjectWorktreeManagementDialog
          key={management.taskId}
          workspacePath={management.workspacePath}
          workspaceIdentity={management.workspaceIdentity}
          workspaceRemoteSessionId={workspaceRemoteSessionId}
          initialSessionId={management.taskId}
          open={management.open}
          onWorktreeDeleted={(binding) => onDeleted(binding.branch)}
          onOpenChange={(open) => {
            // 隐藏保留管理控制器，避免在途归档或差异返回被卸载；关闭后重新读取 Git 占用。
            setManagement((previous) => (previous ? { ...previous, open } : null));
            if (!open) onRefresh?.();
          }}
        />
      ) : null}
    </>
  );
}
