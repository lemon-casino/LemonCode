import { useState, type ReactNode } from "react";
import { XIcon } from "lucide-react";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogClose,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { ProjectWorktreeList } from "./ProjectWorktreeList.js";
import { WorktreeManagementActions } from "./WorktreeManagementActions.js";
import type { WorktreeBinding } from "@lcode/services";

export function ProjectWorktreeManagementDialog({
  workspacePath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  open,
  onOpenChange,
  onSelectSession,
  initialSessionId,
  onWorktreeDeleted,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectSession?: (sessionId: string) => void;
  initialSessionId?: string;
  onWorktreeDeleted?: (binding: WorktreeBinding) => void;
}) {
  const { intl } = useLCodeIntl();
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    initialSessionId ?? null,
  );
  const [deleteRequested, setDeleteRequested] = useState(false);
  const renderDialog = (content: ReactNode) => (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        data-testid="project-worktree-management-dialog"
        className="max-h-[85dvh] overflow-y-auto sm:max-w-xl"
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogClose asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="absolute top-4 right-4"
            data-testid="project-worktrees-close"
            aria-label={intl.formatMessage({ id: "common.close" })}
          >
            <XIcon className="size-4" />
          </Button>
        </DialogClose>
        <DialogHeader>
          <DialogTitle>{intl.formatMessage({ id: "worktree.projectWorktrees" })}</DialogTitle>
          <DialogDescription className="break-all">{workspacePath}</DialogDescription>
        </DialogHeader>
        {selectedSessionId ? (
          <Button
            type="button"
            variant="ghost"
            className="justify-self-start"
            onClick={() => setSelectedSessionId(null)}
          >
            {intl.formatMessage({ id: "worktree.backToProjectWorktrees" })}
          </Button>
        ) : null}
        {content}
      </DialogContent>
    </Dialog>
  );
  // 管理入口不依赖新会话工具栏；隐藏窗口时保留所选控制器，避免在途动作和差异返回入口被卸载。
  return selectedSessionId ? (
    <WorktreeManagementActions
      key={selectedSessionId}
      workspacePath={workspacePath}
      workspaceIdentity={workspaceIdentity}
      workspaceRemoteSessionId={workspaceRemoteSessionId}
      sessionId={selectedSessionId}
      busy={false}
      renderContent={renderDialog}
      onHideReview={() => onOpenChange(false)}
      onShowReview={() => onOpenChange(true)}
      onSelectSession={onSelectSession}
      defaultDeleteOpen={deleteRequested}
      onWorktreeDeleted={onWorktreeDeleted}
    />
  ) : (
    renderDialog(
      <ProjectWorktreeList
        workspacePath={workspacePath}
        workspaceIdentity={workspaceIdentity}
        enabled={open}
        onSelect={(sessionId) => {
          setDeleteRequested(false);
          setSelectedSessionId(sessionId);
        }}
        onDelete={(sessionId) => {
          setDeleteRequested(true);
          setSelectedSessionId(sessionId);
        }}
      />,
    )
  );
}
