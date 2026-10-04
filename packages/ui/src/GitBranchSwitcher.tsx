import { useEffect, useMemo, useRef, useState } from "react";
import type { GitRepositorySummary } from "@lcode/shared";
import { Button } from "@/components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { cn } from "@/components/lib/utils.js";
import {
  GitBranchCreateDialog,
  GitBranchSwitchAssistDialog,
} from "@/git-branch-switcher/GitBranchDialogs.js";
import { GitGraphDialog } from "@/git-graph/GitGraphDialog.js";
import { GitBranchDeletionDialog } from "@/git-branch-switcher/GitBranchDeletionDialog.js";
import {
  GitBranchPickerContent,
  focusBranchPickerSearch,
} from "@/git-branch-switcher/GitBranchPickerContent.js";
import type { GitLocalBranch } from "@lcode/shared";
import { useGitBranchSwitcher } from "@/hooks/useGitBranchSwitcher.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { resolveGitBranchTriggerLabel } from "@/git-branch-switcher/display.js";
import {
  isCoarseTouchDevice,
  shouldRestoreChatInputFocusAfterPickerClose,
} from "@/lib/pickerFocus.js";
import { ChevronDownIcon, GitBranchIcon, GitGraph, LoaderIcon, PlusIcon } from "lucide-react";

interface GitBranchSwitcherProps {
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  gitSummary: GitRepositorySummary;
  dirtyFileCount: number;
  onRefreshGit: () => void;
  className?: string;
  triggerClassName?: string;
  popoverClassName?: string;
  branchListClassName?: string;
  markAsWorkspaceHeaderBranch?: boolean;
  popoverSide?: "top" | "bottom" | "left" | "right";
  avoidPopoverCollisions?: boolean;
  showFooterActions?: boolean;
}

export function GitBranchSwitcher({
  workspacePath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  gitSummary,
  dirtyFileCount,
  onRefreshGit,
  className,
  triggerClassName,
  popoverClassName,
  branchListClassName,
  markAsWorkspaceHeaderBranch = false,
  popoverSide = "top",
  avoidPopoverCollisions = true,
  showFooterActions = true,
}: GitBranchSwitcherProps) {
  const { intl, locale } = useLCodeIntl();
  const numberFormatter = new Intl.NumberFormat(locale);
  const commandListRef = useRef<HTMLDivElement | null>(null);
  const [gitGraphDialogOpen, setGitGraphDialogOpen] = useState(false);
  const deletionScope = workspaceIdentity?.trim() || workspacePath;
  const [deletingBranch, setDeletingBranch] = useState<{
    scope: string;
    branch: GitLocalBranch;
  } | null>(null);
  const {
    open,
    setOpen,
    createDialogOpen,
    setCreateDialogOpen,
    createBranchName,
    setCreateBranchName,
    commitMessage,
    setCommitMessage,
    commitError,
    switchAssistStep,
    switchAssistState,
    branchesResult,
    loadingBranches,
    refreshBranches,
    mutationPending,
    switchBranch,
    createBranchAndSwitch,
    openSwitchCommitDialog,
    closeSwitchAssistDialog,
    commitAndSwitchBranch,
  } = useGitBranchSwitcher({
    workspacePath,
    workspaceIdentity,
    currentBranchName: gitSummary.branchName,
    headRefType: gitSummary.headRefType,
    onRefreshGit,
  });

  const isVisible = gitSummary.isGitAvailable && gitSummary.isRepository;
  const displayedCurrentBranchName = branchesResult?.currentBranchName ?? gitSummary.branchName;
  const triggerLabel = useMemo(
    () =>
      resolveGitBranchTriggerLabel({
        headRefType: gitSummary.headRefType,
        currentBranchName: displayedCurrentBranchName,
        detachedLabel: intl.formatMessage({ id: "git.head.detached" }),
        fallbackLabel: intl.formatMessage({ id: "git.branchSwitcher.label" }),
      }),
    [displayedCurrentBranchName, gitSummary.headRefType, intl],
  );
  const currentBranchDirtyLabel = useMemo(
    () =>
      dirtyFileCount > 0
        ? intl.formatMessage(
            { id: "git.branchSwitcher.currentDirty" },
            { count: numberFormatter.format(dirtyFileCount) },
          )
        : null,
    [dirtyFileCount, intl, numberFormatter],
  );
  const switchAssistCurrentBranchLabel = useMemo(() => {
    if (!switchAssistState) {
      return triggerLabel;
    }

    return resolveGitBranchTriggerLabel({
      headRefType: gitSummary.headRefType,
      currentBranchName: switchAssistState.currentBranchName,
      detachedLabel: intl.formatMessage({ id: "git.head.detached" }),
      fallbackLabel: intl.formatMessage({ id: "git.branchSwitcher.label" }),
    });
  }, [gitSummary.headRefType, intl, switchAssistState, triggerLabel]);

  useEffect(() => {
    if (!open || !branchesResult?.branches.length) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      const selectedItem =
        commandListRef.current?.querySelector<HTMLElement>('[data-branch-current="true"]') ?? null;
      selectedItem?.scrollIntoView({ block: "nearest" });
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [branchesResult, open]);

  if (!isVisible) {
    return null;
  }

  return (
    <>
      <div
        data-workspace-header-branch={markAsWorkspaceHeaderBranch ? "true" : undefined}
        className={cn("flex items-center px-1 pt-2", className)}
      >
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              data-testid="git-branch-switcher-trigger"
              type="button"
              variant="ghost"
              size={"default"}
              disabled={mutationPending}
              aria-label={intl.formatMessage({
                id: "git.branchSwitcher.trigger.ariaLabel",
              })}
              className={cn(
                "h-7 min-w-0 max-w-full gap-1 rounded-md px-1 text-ui-sm",
                triggerClassName,
              )}
            >
              <GitBranchIcon
                data-branch-switcher-primary-icon="true"
                className="size-4 text-foreground-subtle"
              />
              <>
                <span className="min-w-0 truncate text-left" title={triggerLabel}>
                  {triggerLabel}
                </span>
                {loadingBranches || mutationPending ? (
                  <LoaderIcon
                    data-branch-switcher-trailing-icon="true"
                    className="size-3.5 animate-spin text-foreground-subtle"
                  />
                ) : (
                  <ChevronDownIcon
                    data-branch-switcher-trailing-icon="true"
                    className="size-3.5 text-foreground-subtle"
                  />
                )}
              </>
            </Button>
          </PopoverTrigger>
          <PopoverContent
            data-testid="git-branch-picker"
            align="start"
            side={popoverSide}
            avoidCollisions={avoidPopoverCollisions}
            className={cn(
              "max-h-(--radix-popover-content-available-height) w-80 max-w-[calc(100vw-2rem)] gap-0 rounded-lg bg-menu p-0",
              popoverClassName,
            )}
            onOpenAutoFocus={focusBranchPickerSearch}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (
                !shouldRestoreChatInputFocusAfterPickerClose({
                  isCoarseTouchDevice: isCoarseTouchDevice(),
                })
              ) {
                return;
              }
              const input = document.querySelector<HTMLElement>('[data-testid="chat-input"]');
              input?.focus();
            }}
          >
            <GitBranchPickerContent
              listRef={commandListRef}
              branches={branchesResult?.branches ?? []}
              currentBranchName={displayedCurrentBranchName}
              currentBranchDirtyLabel={currentBranchDirtyLabel}
              loading={loadingBranches}
              disabled={mutationPending}
              className={branchListClassName}
              onSelect={(name) => void switchBranch(name)}
              onDelete={(selected) => {
                setDeletingBranch({ scope: deletionScope, branch: selected });
                setOpen(false);
              }}
            />
            {showFooterActions ? (
              <div className="shrink-0 border-t border-border p-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="lg"
                  className="w-full justify-start px-2 text-foreground hover:bg-menu-hover hover:text-foreground"
                  disabled={mutationPending}
                  onClick={() => {
                    setOpen(false);
                    setCreateDialogOpen(true);
                  }}
                >
                  <PlusIcon className="size-4 text-foreground-subtle" />
                  {intl.formatMessage({
                    id: "git.branchSwitcher.createAction",
                  })}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="lg"
                  className="w-full justify-start px-2 text-foreground hover:bg-menu-hover hover:text-foreground"
                  onClick={() => {
                    setOpen(false);
                    setGitGraphDialogOpen(true);
                  }}
                >
                  <GitGraph className="size-4 text-foreground-subtle" />
                  {intl.formatMessage({ id: "gitGraph.menuAction" })}
                </Button>
              </div>
            ) : null}
          </PopoverContent>
        </Popover>
      </div>

      <GitBranchCreateDialog
        open={createDialogOpen}
        branchName={createBranchName}
        mutationPending={mutationPending}
        onOpenChange={(nextOpen) => {
          setCreateDialogOpen(nextOpen);
          if (!nextOpen) {
            setCreateBranchName("");
          }
        }}
        onBranchNameChange={setCreateBranchName}
        onCancel={() => {
          setCreateDialogOpen(false);
          setCreateBranchName("");
        }}
        onSubmit={() => {
          void createBranchAndSwitch();
        }}
      />

      <GitBranchDeletionDialog
        key={workspaceIdentity?.trim() || workspacePath}
        workspacePath={workspacePath}
        workspaceIdentity={workspaceIdentity}
        workspaceRemoteSessionId={workspaceRemoteSessionId}
        branch={deletingBranch?.scope === deletionScope ? deletingBranch.branch : null}
        onClose={() => setDeletingBranch(null)}
        onRefresh={() => {
          void refreshBranches();
          onRefreshGit();
        }}
        onDeleted={() => {
          setDeletingBranch(null);
          void refreshBranches();
          onRefreshGit();
        }}
      />

      <GitGraphDialog
        open={gitGraphDialogOpen}
        workspacePath={workspacePath}
        onOpenChange={setGitGraphDialogOpen}
      />

      <GitBranchSwitchAssistDialog
        step={switchAssistStep}
        state={switchAssistState}
        currentBranchLabel={switchAssistCurrentBranchLabel}
        commitMessage={commitMessage}
        commitError={commitError}
        mutationPending={mutationPending}
        onClose={closeSwitchAssistDialog}
        onOpenCommit={openSwitchCommitDialog}
        onCommitMessageChange={setCommitMessage}
        onSubmit={() => {
          void commitAndSwitchBranch();
        }}
      />
    </>
  );
}
