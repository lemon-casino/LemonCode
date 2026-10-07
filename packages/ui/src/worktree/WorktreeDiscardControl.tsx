import { useState } from "react";
import { Trash2Icon } from "lucide-react";
import type { WorktreeBinding, WorktreeIntegration } from "@lcode/services";
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
import { useLCodeIntl } from "@/i18n/IntlProvider.js";

export function WorktreeDiscardControl({
  binding,
  operation,
  disabled,
  pending,
  error,
  onDiscard,
  defaultOpen = false,
}: {
  binding: WorktreeBinding;
  operation: WorktreeIntegration | null;
  disabled: boolean;
  pending: boolean;
  error?: string;
  onDiscard: () => Promise<boolean>;
  defaultOpen?: boolean;
}) {
  const { intl } = useLCodeIntl();
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="space-y-2 border-t border-border pt-3">
      <Button
        type="button"
        variant="destructive"
        data-testid="worktree-discard"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        <Trash2Icon className="size-4" />
        {intl.formatMessage({ id: "worktree.discard" })}
      </Button>
      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          if (!pending) setOpen(next);
        }}
      >
        <AlertDialogContent
          data-testid="worktree-discard-dialog"
          className="max-h-[85dvh] overflow-y-auto"
        >
          <AlertDialogHeader>
            <AlertDialogTitle>
              {intl.formatMessage({ id: "worktree.discardTitle" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {intl.formatMessage({ id: "worktree.discardDescription" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {binding.environmentRef ? (
            <p className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "runtimeEnvironment.lifecycleData" })}
            </p>
          ) : null}
          <dl className="space-y-2 text-ui-sm">
            <div>
              <dt className="text-foreground-subtle">
                {intl.formatMessage({ id: "worktree.discardDirectory" })}
              </dt>
              <dd className="break-all font-mono">{binding.checkoutPath}</dd>
            </div>
            <div>
              <dt className="text-foreground-subtle">
                {intl.formatMessage({ id: "worktree.discardBranch" })}
              </dt>
              <dd className="break-all font-mono">{binding.branch}</dd>
            </div>
            {operation ? (
              <div>
                <dt className="text-foreground-subtle">
                  {intl.formatMessage({ id: "worktree.integrationDirectory" })}
                </dt>
                <dd className="break-all font-mono">{operation.checkoutPath}</dd>
              </div>
            ) : null}
          </dl>
          {error ? (
            <p role="alert" className="break-words text-ui-sm text-destructive">
              {error}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel asChild>
              <Button type="button" variant="outline" disabled={pending}>
                {intl.formatMessage({ id: "common.cancel" })}
              </Button>
            </AlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              data-testid="worktree-discard-confirm"
              disabled={disabled}
              onClick={() => {
                void onDiscard().then((success) => {
                  if (success) setOpen(false);
                });
              }}
            >
              {intl.formatMessage({
                id: pending ? "worktree.discardPending" : "worktree.discardConfirm",
              })}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
