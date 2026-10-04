import { useRef, useState } from "react";
import type { GitLocalBranch } from "@lcode/shared";
import { ChevronDownIcon, GitBranchIcon, LoaderIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import {
  GitBranchPickerContent,
  focusBranchPickerSearch,
} from "@/git-branch-switcher/GitBranchPickerContent.js";
import { GitBranchDeletionDialog } from "@/git-branch-switcher/GitBranchDeletionDialog.js";
import { useWorktreeBaseBranches } from "@/hooks/useWorktreeBaseBranches.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";

export function WorktreeBaseBranchPicker({
  workspacePath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  baseRef,
  currentBranchName,
  frozen,
  supported,
  onChoose,
  onRefreshGit,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  baseRef?: string;
  currentBranchName: string | null;
  frozen: boolean;
  supported: boolean;
  onChoose: (baseRef: string | undefined) => void;
  onRefreshGit: () => void;
}) {
  const { intl } = useLCodeIntl();
  const scope = workspaceIdentity?.trim() || workspacePath;
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState<{ scope: string; branch: GitLocalBranch } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const branches = useWorktreeBaseBranches(workspacePath, workspaceIdentity, open && !frozen);
  const refresh = () => {
    void branches.refresh();
    onRefreshGit();
  };
  return (
    <>
      <Popover open={open && !frozen} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            data-testid="worktree-base-trigger"
            variant="ghost"
            className="h-7 min-w-0 max-w-full shrink gap-1 rounded-md px-1 text-ui-sm"
            disabled={frozen || !supported}
            title={baseRef ?? currentBranchName ?? "HEAD"}
          >
            <GitBranchIcon className="size-4 shrink-0 text-foreground-subtle" />
            <span className="min-w-0 truncate">
              {intl.formatMessage({ id: "worktree.base" })}:{" "}
              {baseRef ?? currentBranchName ?? "HEAD"}
            </span>
            {branches.loading ? (
              <LoaderIcon className="size-3.5 animate-spin text-foreground-subtle" />
            ) : (
              <ChevronDownIcon className="size-3.5 text-foreground-subtle" />
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          data-testid="worktree-base-picker"
          side="top"
          align="start"
          className="max-h-(--radix-popover-content-available-height) w-80 max-w-[calc(100vw-2rem)] gap-0 rounded-lg bg-menu p-0"
          onOpenAutoFocus={focusBranchPickerSearch}
        >
          {/* 基线复用本地分支列表的展示与键盘操作，仅保留只写草稿的选择命令。 */}
          <GitBranchPickerContent
            listRef={listRef}
            testId="worktree-base-list"
            className="max-h-64"
            branches={branches.result?.branches ?? []}
            currentBranchName={branches.result?.currentBranchName ?? currentBranchName}
            selectedBranchName={baseRef ?? "HEAD"}
            currentBranchDirtyLabel={null}
            headOption
            loading={branches.loading}
            error={branches.error}
            onRetry={() => void branches.refresh()}
            disabled={frozen}
            description={intl.formatMessage({ id: "worktree.baseDescription" })}
            onSelect={(name) => {
              onChoose(name === "HEAD" ? undefined : name);
              setOpen(false);
            }}
            onDelete={(branch) => {
              setDeleting({ scope, branch });
              setOpen(false);
            }}
          />
        </PopoverContent>
      </Popover>
      <GitBranchDeletionDialog
        key={scope}
        workspacePath={workspacePath}
        workspaceIdentity={workspaceIdentity}
        workspaceRemoteSessionId={workspaceRemoteSessionId}
        branch={deleting?.scope === scope ? deleting.branch : null}
        onClose={() => setDeleting(null)}
        onRefresh={refresh}
        onDeleted={(name) => {
          setDeleting(null);
          if (baseRef === name) onChoose(undefined);
          refresh();
        }}
      />
    </>
  );
}
