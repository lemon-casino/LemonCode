import type { ReactNode } from "react";
import { useState } from "react";
import type { WorktreeBinding } from "@lcode/services";
import { FolderGit2Icon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog.js";
import { ReviewDialogDismiss } from "@/git-action-menu/ReviewDialogDismiss.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { ReviewActionSlotContext } from "@/git-action-menu/ReviewActionBar.js";

export function WorktreeReviewDialog({
  binding,
  targetBranch,
  open,
  onOpenChange,
  onManage,
  children,
  management = false,
}: {
  binding: WorktreeBinding;
  targetBranch: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onManage: () => void;
  children: ReactNode;
  management?: boolean;
}) {
  const { intl } = useLCodeIntl();
  const [actionSlot, setActionSlot] = useState<HTMLDivElement | null>(null);
  const manage = intl.formatMessage({
    id: management ? "worktree.manage" : "git.commitWorkflow.worktree.title",
  });
  return (
    <>
      {/* 原因：准备卡已由首条聊天消息承载；顶部再渲染会重复，管理入口只展示目录。 */}
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
        <ReviewActionSlotContext.Provider value={actionSlot}>
          <DialogContent
            showCloseButton={false}
            onPointerDownOutside={(event) => event.preventDefault()}
            onInteractOutside={(event) => event.preventDefault()}
            className="flex max-h-[85dvh] w-[calc(100%-2rem)] max-w-3xl flex-col gap-0 overflow-clip p-0"
            data-testid="worktree-task-dialog"
          >
            <ReviewDialogDismiss onClose={() => onOpenChange(false)} />
            <div className="shrink-0 space-y-1 border-b border-border p-4 pr-10">
              <DialogTitle className="pr-8 text-ui-base">{manage}</DialogTitle>
              <DialogDescription className="break-all pr-8 font-mono text-ui-sm">
                {management
                  ? binding.branch
                  : intl.formatMessage(
                      { id: "worktree.sourceToTarget" },
                      { source: binding.branch, target: targetBranch },
                    )}
                <br />
                {binding.workspacePath}
              </DialogDescription>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">{children}</div>
            <div className="flex shrink-0 items-end gap-2 border-t border-border bg-popover px-4 py-3">
              <div
                ref={setActionSlot}
                className="flex min-w-0 flex-1 flex-wrap justify-end gap-2"
              />
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                {intl.formatMessage({ id: "common.close" })}
              </Button>
            </div>
          </DialogContent>
        </ReviewActionSlotContext.Provider>
      </Dialog>
    </>
  );
}
