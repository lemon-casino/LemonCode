import type { ReactNode } from "react";
import type { WorktreeBinding } from "@lcode/services";
import { FolderGit2Icon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog.js";
import { ReviewDialogDismiss } from "@/git-action-menu/ReviewDialogDismiss.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { LiveWorktreePreparationCard } from "./WorktreePreparationCard.js";

export function WorktreeReviewDialog({
  binding,
  targetBranch,
  open,
  onOpenChange,
  onManage,
  children,
}: {
  binding: WorktreeBinding;
  targetBranch: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onManage: () => void;
  children: ReactNode;
}) {
  const { intl } = useLCodeIntl();
  const manage = intl.formatMessage({ id: "worktree.manage" });
  return (
    <>
      {binding.preparation ? (
        <div className="px-2 py-1">
          <LiveWorktreePreparationCard binding={binding} />
        </div>
      ) : null}
      <div
        className="flex min-w-0 flex-wrap items-center gap-2 px-2 py-1 text-ui-sm"
        data-testid="worktree-task-location"
      >
        <FolderGit2Icon className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate font-mono" title={binding.workspacePath}>
          {binding.workspacePath}
        </span>
        <Button type="button" size="sm" variant="ghost" onClick={onManage}>
          {manage}
        </Button>
      </div>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          showCloseButton={false}
          onPointerDownOutside={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
          className="max-h-[85dvh] w-[calc(100%-2rem)] max-w-2xl overflow-y-auto"
          data-testid="worktree-task-dialog"
        >
          <ReviewDialogDismiss onClose={() => onOpenChange(false)} />
          <DialogTitle className="pr-8 text-ui-base">{manage}</DialogTitle>
          <DialogDescription className="break-all pr-8 font-mono text-ui-sm">
            {intl.formatMessage(
              { id: "worktree.sourceToTarget" },
              { source: binding.branch, target: targetBranch },
            )}
            <br />
            {binding.workspacePath}
          </DialogDescription>
          {children}
        </DialogContent>
      </Dialog>
    </>
  );
}
